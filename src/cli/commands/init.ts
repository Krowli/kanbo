import { existsSync } from 'node:fs'
import { basename, relative, resolve } from 'node:path'

import type { Command } from 'commander'

import { DEFAULT_BOARD_FILE_PATH } from '../../default-board-file-path'
import type { ColumnSpec } from '../../domain/column-templates'
import {
  COLUMN_TEMPLATE_IDS,
  COLUMN_TEMPLATES,
  findCatalogueColumn,
  hasReadyColumn,
  ownColumn,
} from '../../domain/column-templates'
import { maskDatabaseUrl } from '../../domain/database-url'
import { isValidCardKey, suggestCardKey } from '../../domain/key-suggestion'
import type { BoardWorkspaceIdentity } from '../../domain/numbering'
import { normalizeStatusName } from '../../domain/status-name'
import { openBoardDatabase } from '../../sqlite/open-database'
import type { SqliteDatabase } from '../../sqlite/transaction'
import type { KanboBinding } from '../binding'
import { findBinding, readProjectBinding } from '../binding'
import type { BoardCommandOptions } from '../command'
import { openBoardSession } from '../command'
import type { BoardTarget } from '../db-target'
import { describeTarget, resolveDatabaseUrl, resolveDbTarget, resolveHostDbPath } from '../db-target'
import type { CliResult } from '../output'
import { CliError, EXIT_NOT_RESOLVED, printResult, readFormat } from '../output'
import type { AgentId } from '../setup/agents'
import { AGENT_IDS, AGENTS, defaultMcpScope, detectAgents, parseAgentId } from '../setup/agents'
import { describeManualOutcome, pendingItems, planConnect } from '../setup/connect-plan'
import { inspectBoardFile, inspectPostgresWorkspace } from '../setup/existing-workspace'
import type { FileOutcome } from '../setup/file-change'
import type { AppliedInitPlan, InitFileChange, InitPlan } from '../setup/init-plan'
import { applyInitPlan, assertOwnBoardFile } from '../setup/init-plan'
import { readLaunchWarning } from '../setup/launch-warning'
import { mcpLaunchSpec } from '../setup/mcp-launch'
import type { McpClient, ProjectInstructionTarget } from '../setup/paths'
import { MCP_CLIENTS } from '../setup/paths'
import { canPrompt } from '../ui/environment'
import { CancelledError, getUi } from '../ui/ui'
import { printInitOutro, runInitWizard } from '../wizard/init-wizard'
import { resolveWorkspace } from '../workspace'
import { initGlobal } from './init-global'

/**
 * `kanbo init` — tying a project folder to a board, and telling the agents
 * that work in it what the board expects.
 *
 * Three things come out of it, and each is optional except the first: the
 * binding, so no later command has to be told which workspace this is; a block
 * in the project's agent instructions, so an agent reads the board's rules
 * without being handed them; and a registration of the board's MCP server with
 * whichever tools the person actually uses. Nothing is written to a file the
 * person did not ask for, and nothing is written twice.
 *
 * Every question comes first. The answers become a plan (`setup/init-plan.ts`)
 * that a person at a terminal is shown and asked about once; only then is any
 * of it written, the binding included.
 */

/**
 * What a person is told when an external board is named and nothing says which
 * workspace it is about. There is no table to look the answer up in, and a card
 * numbered under a guess carries that guess for the rest of its life.
 */
const EXTERNAL_WORKSPACE_MESSAGE
  = 'Could not tell which project this is, and a shared Postgres board keeps no list of projects to look it up '
    + 'in. Run this again with --workspace <id> --key <KEY>, or with --db (or KANBO_DB_PATH) naming the app\'s '
    + 'database that knows this project.'

/** What a person is told when a board file of the project's own and an external one are both named at once. */
const FILE_AND_DATABASE_URL_MESSAGE
  = 'One board at a time: pass --file for this project\'s own board file or --database-url for a shared '
    + 'Postgres board, not both.'

/**
 * What a person is told when their agents are about to reach the board as its
 * owner. Not a refusal: the board works this way from the first minute, and the
 * rule an agent is missing is one the database keeps, not this command.
 */
export const AGENT_URL_MISSING_WARNING
  = 'kanbo: agents in this project will reach the board with the connection string you gave, which owns it. '
    + 'Until you run "kanbo roles apply" and record the agent role\'s own string with --agent-url, an agent '
    + 'here can approve its own work.'

type InstructionTarget = ProjectInstructionTarget | 'none'

/** What a person is told when the setup stopped at a question. */
export const INIT_CANCELLED_MESSAGE = 'Cancelled — nothing was written.'

/** What a board set up without its agents ends with. */
export const CONNECT_LATER_TIP = 'Agents don\'t know about this board yet: kanbo connect <agent>, or kanbo instructions --copy and paste it.'

const CONNECT_VALUES = `${AGENT_IDS.join(', ')}, all or none`

export interface InitOptions extends BoardCommandOptions {
  /** Set up this person's own agent tools for every project, instead of binding this one. */
  global?: boolean
  board?: string
  identifier?: string
  agentUrl?: string
  /** Parsed per mode: one project file, or a list of the person's own files with `--global`. */
  instructions?: string
  mcp?: McpClient[]
  yes?: boolean
  /**
   * `--file` with no value parses to `true` (commander's rule for an optional
   * option argument); `--file <path>` parses to that path, relative to the
   * project root.
   */
  file?: string | boolean
  /** `--key`: `--identifier`, checked to be a card key and upper-cased. */
  key?: string
  /** `--columns`: what a new board starts with; the standard set when not given. */
  columns?: ColumnSpec[]
  /** `--connect`: the agents to connect as `kanbo connect` does; empty for none. */
  connect?: AgentId[]
  /** `--first-card`: a card to put in To Do once the board is there. */
  firstCard?: string
  /** `--migrate`: create the shared board's tables now, as `kanbo migrate` does. */
  migrate?: boolean
}

export function registerInitCommand(program: Command): void {
  // Not `withBoardOptions`: `--db` means something else here, and the two
  // board flags stand together rather than refusing each other. The rest is
  // spelled the same as everywhere else.
  program
    .command('init')
    .description('set up a board for this project and connect its agents (a wizard in a terminal)')
    .option('--db <path>', 'host database file to read this project\'s workspace from')
    .option('--database-url <url>', 'external Postgres board to bind this project to')
    .option('--file [path]', `use a board file of this project's own instead of a host database or an `
    + `external board (default ${DEFAULT_BOARD_FILE_PATH})`)
    .option('--workspace <nameOrId>', 'workspace this project is')
    .option('--json <fields>', 'print only these comma-separated fields, as JSON')
    .option('--format <format>', 'output format: json or pretty')
    .option('--board <id>', 'the board inside the workspace, when it has more than one')
    .option('--identifier <key>', 'what this workspace\'s card keys start with, for an external board')
    .option('--key <KEY>', 'what card numbers start with, e.g. MYA for MYA-001 (the same as --identifier)', parseKey)
    .option('--columns <columns>', `the columns a new board starts with: ${COLUMN_TEMPLATE_IDS.join(', ')}, or a `
    + 'comma-separated list that includes To Do', parseColumns)
    .option('--connect <agents>', `connect these agents, as kanbo connect does: ${CONNECT_VALUES}`, parseConnect)
    .option('--first-card <title>', 'put a first card in To Do')
    .option('--migrate', 'create the board\'s tables in the external Postgres database now')
    .option('--agent-url <url>', 'the connection string agents get, when it is not the one above')
    .option('--instructions <file>', 'where to write the instruction block: claude, agents or none; with '
    + '--global, a comma-separated list of claude, codex, gemini, or none')
    .option('--mcp <clients>', `register the board's MCP server with ${MCP_CLIENTS.join(', ')}`, parseMcpClients)
    .option('--global', 'set up your own agent tools for every project instead of binding this one; binds no board')
    .option('--yes', 'take the defaults instead of asking')
    .action(async (options: InitOptions) => {
      if (options.global) {
        await initGlobal(options)
        return
      }
      // Refused before anything is asked or written, as a parse-time check would be.
      if (options.instructions !== undefined) {
        parseInstructions(options.instructions)
      }
      readFormat(options)
      const request = normalizeInitOptions(options)
      // Machine output wants the result on stdout, not a wizard drawn over it.
      if (!request.yes && !request.json && !request.format && canPrompt()) {
        await initWithWizard(request)
        return
      }
      const plan = withoutUnconfirmedAgentFiles(await planInit(process.cwd(), request), request)
      warnAboutOwnerAccess(plan.target, request)
      const applied = await applyInitPlan(plan)
      printResult(describeInit(plan, applied, request), request)
    })
}

/**
 * `kanbo init` at a person's terminal: the wizard asks what the flags did not
 * say, shows the plan and asks once; only then is anything written.
 */
async function initWithWizard(options: InitOptions): Promise<void> {
  const ui = getUi()
  let answered
  try {
    answered = await runInitWizard({
      cwd: process.cwd(),
      options,
      ui,
      plan: planInit,
      detect: projectDir => detectAgents({ projectDir }),
      launchWarning: readLaunchWarning(),
      agentUrlWarning: AGENT_URL_MISSING_WARNING,
    })
  }
  catch (error) {
    throw error instanceof CancelledError ? new CancelledError(INIT_CANCELLED_MESSAGE) : error
  }
  printInitOutro(ui, answered, await applyInitPlan(answered.plan))
}

/**
 * Agent files — instructions, MCP settings, `claude mcp` — change only on a
 * yes: the wizard's, or `--yes`. Without either (an agent's shell, a script,
 * machine output) the board is still set up and the agent files are left as
 * they are, and the person is told how to connect them, as `kanbo connect` would.
 */
function withoutUnconfirmedAgentFiles(plan: InitPlan, options: InitOptions): InitPlan {
  const pending = plan.fileChanges.some(({ change }) => change.next !== null) || (plan.connect !== null && pendingItems(plan.connect).length > 0)
  if (options.yes || !pending) {
    return plan
  }
  const agents = options.connect?.length
    ? options.connect
    : [...new Set([
        ...(options.instructions === 'claude' ? ['claude'] : options.instructions === 'agents' ? ['codex'] : []),
        ...(options.mcp ?? []),
      ])]
  console.error(`Not changing agent files without a yes: run kanbo connect ${agents.join(' ') || '<agent>'} --yes`)
  return { ...plan, fileChanges: [], connect: null }
}

/** The flags as `planInit` takes them: `--key` is `--identifier`, and `--connect` does not mix with the older flags. */
export function normalizeInitOptions(options: InitOptions): InitOptions {
  if (options.connect && (options.instructions !== undefined || options.mcp)) {
    throw new CliError(1, 'Use --connect, or the older --instructions and --mcp, not both.')
  }
  if (options.key === undefined) {
    return options
  }
  if (options.identifier !== undefined && options.identifier.trim().toUpperCase() !== options.key) {
    throw new CliError(1, '--key and --identifier are the same thing; pass one of them.')
  }
  return { ...options, identifier: options.key }
}

/**
 * Everything `init` will do, with every question asked — nothing is written
 * here. The board comes first: which one, and which workspace it is about.
 * A board file of the project's own is created only when the plan is applied.
 *
 * The wizard's answers come here as the flags that say the same thing, so a
 * wizard run and the equivalent command line plan exactly the same changes.
 */
export async function planInit(projectDir: string, options: InitOptions): Promise<InitPlan> {
  const { target, workspace, boardFile } = await resolveBoard(projectDir, options)
  const migrate = target.kind === 'postgres' && Boolean(options.migrate)
  // A shared board's workspace another member already set up keeps its columns.
  const newBoard = (boardFile !== null && !boardFile.exists)
    || (migrate && !(await inspectPostgresWorkspace(target.url, workspace.id))?.hasColumns)
  return {
    projectDir,
    target,
    workspace,
    binding: buildBinding(projectDir, target, workspace, options),
    boardFile,
    columns: newBoard ? options.columns ?? COLUMN_TEMPLATES.standard : null,
    migrate,
    fileChanges: [
      ...await planInstructions(projectDir, options),
      ...await planMcpServers(projectDir, options.mcp ?? []),
    ],
    connect: options.connect?.length ? await planAgents(projectDir, options.connect, options) : null,
    firstCard: options.firstCard?.trim() || null,
  }
}

/** Connect these agents the way `kanbo connect <agents>` does: the kanbo section in the project, the MCP server where each agent reads it. */
async function planAgents(projectDir: string, agents: AgentId[], options: InitOptions): Promise<InitPlan['connect']> {
  return await planConnect(
    agents.map(agent => ({ agent, instructions: 'project', mcp: defaultMcpScope(agent) })),
    { projectDir, yes: options.yes },
  )
}

/** The board this project is bound to, and the workspace on it. */
async function resolveBoard(
  projectDir: string,
  options: InitOptions,
): Promise<Pick<InitPlan, 'target' | 'workspace' | 'boardFile'>> {
  if (options.file !== undefined || namesNoBoard(projectDir, options)) {
    return await resolveOwnFile(projectDir, options)
  }
  const target = resolveInitTarget(projectDir, options)
  if (target.kind === 'postgres') {
    return { target, workspace: await resolveExternalWorkspace(projectDir, target.url, options), boardFile: null }
  }
  return { target, workspace: await readSessionWorkspace(options), boardFile: null }
}

/**
 * Nothing says where a board is: no flag, no environment, no binding at or
 * above this folder. Then a plain `kanbo init` does what `kanbo init --file`
 * does — a person on a machine with nothing else installed gets a board, not a
 * refusal that names a flag.
 */
function namesNoBoard(projectDir: string, options: InitOptions): boolean {
  return !options.db?.trim()
    && !options.databaseUrl?.trim()
    && !process.env.KANBO_DB_PATH?.trim()
    && !process.env.KANBO_DATABASE_URL?.trim()
    && findBinding(projectDir) === null
}

/** The workspace a host database — or the board file this project is already bound to — says this project is. */
async function readSessionWorkspace(options: InitOptions): Promise<BoardWorkspaceIdentity> {
  const session = await openBoardSession(options, 'read')
  try {
    return session.workspace
  }
  finally {
    await session.close()
  }
}

/**
 * Which board `init` is binding this project to.
 *
 * `--db` means something else here than it does in every other command: it
 * names the host database this one reads the workspace off, not the
 * board being bound. So the external board is asked for on its own — the flag,
 * the environment, then the binding this project already has — and only when
 * there is none is the board file itself the board. Always the person's
 * connection string: binding a project is not something an agent does.
 */
function resolveInitTarget(projectDir: string, options: InitOptions): BoardTarget {
  const url = resolveDatabaseUrl({ explicitUrl: options.databaseUrl, cwd: projectDir, asAgent: false })
  return url ? { kind: 'postgres', url } : resolveDbTarget({ explicitPath: options.db, cwd: projectDir })
}

/**
 * A board file of this project's own — `.kanbo/board.db` by default — with no
 * host app and no Postgres anywhere near it.
 *
 * Nothing is created here: the file is created, migrated with this package's
 * own chain and marked as kanbo's when the plan is applied (`init-plan.ts`),
 * because nothing else ever will — a host app migrates its own database and an
 * external database is migrated by `kanbo migrate`, but a file of this
 * package's own has no other owner to do it later (rulings 5-4, 5-5). A file
 * already at the path that is not kanbo's is refused now, before any question.
 *
 * The workspace is settled without opening a host database at all (ruling
 * 5-9): this is the one command that has to work on a machine with nothing
 * else installed, and the answer it needs — an id and a card-key stem — is
 * either typed, already in the binding, or the folder's own name.
 */
async function resolveOwnFile(projectDir: string, options: InitOptions): Promise<Pick<InitPlan, 'target' | 'workspace' | 'boardFile'>> {
  if (options.databaseUrl) {
    throw new CliError(1, FILE_AND_DATABASE_URL_MESSAGE)
  }

  // A bare --file keeps the file this project is already bound to: after the
  // file went missing, `kanbo init --file` puts a new board where it was.
  const relativePath = typeof options.file === 'string' && options.file.trim()
    ? options.file.trim()
    : readProjectBinding(projectDir)?.dbPath?.trim() || DEFAULT_BOARD_FILE_PATH
  const absolutePath = resolve(projectDir, relativePath)
  const exists = existsSync(absolutePath)
  if (exists) {
    assertOwnBoardFile(absolutePath)
  }
  const workspace = await resolveOwnFileWorkspace(projectDir, absolutePath, options)
  return {
    target: { kind: 'sqlite', path: absolutePath, owner: 'kanbo' },
    workspace,
    boardFile: { path: absolutePath, exists },
  }
}

/**
 * What the binding says afterwards.
 *
 * Merged into what this project already recorded, never replacing it: every
 * field this command line did not speak about keeps the value it had. A person
 * re-running `init` to refresh the instruction block said nothing about the
 * board, and a second run that dropped the connection string would leave the
 * project bound to nothing.
 *
 * The fields an external board adds are written only when there is one: they
 * are what every later command reaches the database by, and a project that has
 * nothing to do with one should not carry a connection string at all.
 *
 * This file is the only place a connection string is written down, and
 * `writeBinding` is what keeps it out of git. The MCP registrations below are
 * the project's own shared files and carry no secret at all — `kanbo mcp`
 * resolves its board from this binding like every other command.
 */
function buildBinding(
  projectDir: string,
  target: BoardTarget,
  workspace: BoardWorkspaceIdentity,
  options: InitOptions,
): KanboBinding {
  const existing = readProjectBinding(projectDir)
  const ownFile = target.kind === 'sqlite' && target.owner === 'kanbo'
  const hasWorkspacesTable = target.kind === 'sqlite' && target.owner === 'host'
  const binding: KanboBinding = {
    schemaVersion: 1,
    workspaceId: workspace.id,
    boardId: options.board ?? existing?.boardId ?? null,
    dbPath: ownFile ? relative(projectDir, target.path) : existing?.dbPath ?? null,
  }
  if (hasWorkspacesTable) {
    return binding
  }

  // Neither an external board nor a board file of this project's own has a
  // `workspaces` row to read the card-key stem off later, so it is written
  // down here — the one thing the two share, alongside `databaseUrl` below,
  // which only a Postgres board has any use for.
  const withIdentifier: KanboBinding = { ...binding, identifier: workspace.identifier }
  if (target.kind !== 'postgres') {
    return withIdentifier
  }

  const agentUrl = options.agentUrl?.trim() || existing?.agentDatabaseUrl
  return {
    ...withIdentifier,
    databaseUrl: target.url,
    ...(agentUrl ? { agentDatabaseUrl: agentUrl } : {}),
  }
}

/**
 * What the host database and the flags say about the workspace a board with no
 * `workspaces` table is being bound to — never the whole answer by itself,
 * since either piece may be missing.
 */
interface WorkspaceGuess {
  local: BoardWorkspaceIdentity | null
  id?: string
  identifier?: string
}

/**
 * Ask the host database first, because the ordinary case is a person moving a
 * project they already work on onto a board of its own, and their own machine
 * already knows both answers; what they typed on the command line wins over
 * it. Callers decide what to do when a piece is still missing: an external
 * board refuses outright, while a board file of this project's own has the
 * folder's own name to fall back on.
 */
async function guessWorkspace(projectDir: string, options: InitOptions): Promise<WorkspaceGuess> {
  const local = await readLocalWorkspace(projectDir, options)
  // Then what this project is already bound to: a second `init` on a bound
  // project is about the same workspace, and its key goes with its id.
  const bound = readProjectBinding(projectDir)
  const id = local?.id ?? (options.workspace?.trim() || bound?.workspaceId.trim() || undefined)
  const boundIdentifier = id !== undefined && id === bound?.workspaceId.trim() ? bound.identifier?.trim() : undefined
  return {
    local,
    id,
    identifier: options.identifier?.trim() || local?.identifier || boundIdentifier || undefined,
  }
}

/**
 * Which workspace an external board's cards belong to, and what their keys
 * start with.
 *
 * When neither the host database nor the flags say the whole answer, the
 * command refuses rather than inventing a key: a card numbered under a guess
 * carries that guess for the rest of its life, and an external database is
 * shared in a way a board file of this project's own is not.
 */
async function resolveExternalWorkspace(projectDir: string, url: string, options: InitOptions): Promise<BoardWorkspaceIdentity> {
  const guess = await guessWorkspace(projectDir, options)
  // A workspace the shared board already has cards in says its own key.
  const identifier = guess.identifier || (guess.id ? (await inspectPostgresWorkspace(url, guess.id))?.key : null)
  if (!guess.id || !identifier) {
    throw new CliError(EXIT_NOT_RESOLVED, EXTERNAL_WORKSPACE_MESSAGE)
  }
  return { id: guess.id, identifier, name: guess.local?.id === guess.id ? guess.local.name : identifier }
}

/**
 * The same question, for a board file of this project's own — asked of three
 * things, none of which is a database (ruling 5-9).
 *
 * `kanbo init --file` is the one command this package promises works with
 * nothing else installed, so there is nothing to refuse about it and nothing to
 * look up: what the person typed wins, then the id this project is already
 * bound to, and failing both the folder's own name, slugged, stands in for the
 * id — and `suggestCardKey` of that name for the card key of a workspace that
 * has none yet.
 *
 * The binding comes second rather than last because the id in it is the id the
 * cards in the file are already numbered under — a second `init` that fell back
 * to the slug would leave the project pointing at a workspace with no cards in
 * it (ruling 3-16). It is also how a host app and the command line stay on one
 * board: an app that attaches the file may rewrite the binding to its own
 * workspace id (ruling 5-7), and this is what keeps it. The card key follows the id it
 * belongs to: naming a different workspace on the command line does not inherit
 * the old one's stem.
 */
async function resolveOwnFileWorkspace(projectDir: string, path: string, options: InitOptions): Promise<BoardWorkspaceIdentity> {
  const bound = readProjectBinding(projectDir)
  const slug = deriveProjectSlug(projectDir)
  const id = options.workspace?.trim() || bound?.workspaceId.trim() || slug
  const boundIdentifier = id === bound?.workspaceId.trim() ? bound.identifier?.trim() : null
  const identifier = options.identifier?.trim()
    || boundIdentifier
    // A board file that is there without a binding keeps numbering its cards as it did.
    || (await inspectBoardFile(path, id))?.key
    || suggestCardKey(basename(resolve(projectDir)))
  return { id, identifier, name: identifier }
}

/** A workspace id from the project folder's own name, for the machine with nothing else to ask. */
export function deriveProjectSlug(projectDir: string): string {
  const slug = basename(resolve(projectDir)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug || 'project'
}

/**
 * The workspace this folder is, as a host database on this machine knows it —
 * or nothing at all, when there is no host database here to ask.
 *
 * A workspace that database *refuses* is a different answer entirely, and it is
 * only swallowed when the person named nothing: not knowing which workspace an
 * unnamed folder is, is what `--workspace` and `--identifier` are for. A name
 * they did type and that database rejects — no such workspace, or two by that
 * name — has to reach them, because the alternative is writing what they typed
 * into the binding as if it were an id and numbering cards under a workspace
 * that exists nowhere.
 */
async function readLocalWorkspace(projectDir: string, options: InitOptions): Promise<BoardWorkspaceIdentity | null> {
  const board = await openHostDatabase(options)
  if (!board) {
    return null
  }

  try {
    return resolveWorkspace(
      { kind: 'sqlite', database: board.database },
      { explicit: options.workspace, cwd: projectDir },
    )
  }
  catch (error) {
    if (options.workspace?.trim()) {
      throw error
    }
    return null
  }
  finally {
    board.close()
  }
}

/**
 * The host database `--db` or `KANBO_DB_PATH` names, or nothing — a machine is
 * allowed to have none. `resolveHostDbPath` rather than the ordinary resolver:
 * a project bound to a board file of its own by an earlier `kanbo init --file`
 * still asks this, and that binding names its own file, not a host database.
 */
async function openHostDatabase(options: InitOptions): Promise<{ database: SqliteDatabase, close: () => void } | null> {
  try {
    return await openBoardDatabase(resolveHostDbPath(options.db))
  }
  catch {
    return null
  }
}

/**
 * Say so when the agents of this project will reach the board as its owner.
 *
 * On stderr, because stdout belongs to the result, and once — a person who has
 * already recorded an agent connection string hears nothing.
 */
function warnAboutOwnerAccess(target: BoardTarget, options: InitOptions): void {
  if (target.kind === 'postgres' && !options.agentUrl?.trim()) {
    console.error(AGENT_URL_MISSING_WARNING)
  }
}

/**
 * The block in the file `--instructions` named. Without the flag nothing is
 * written into a project's instructions: that is `--connect`, the wizard, or
 * `kanbo connect` later.
 */
async function planInstructions(projectDir: string, options: InitOptions): Promise<InitFileChange[]> {
  const target = options.instructions === undefined ? 'none' : parseInstructions(options.instructions)
  if (target === 'none') {
    return []
  }
  // CLAUDE.md is Claude Code's; AGENTS.md is the one Codex and Cursor read.
  const agent = target === 'claude' ? 'claude' : 'codex'
  const plan = await planConnect([{ agent, instructions: 'project', mcp: null }], { projectDir, yes: options.yes })
  for (const note of plan.notes) {
    console.error(note)
  }
  return plan.items.flatMap(item => (item.kind === 'instructions' ? [{ kind: 'instructions' as const, change: item.change }] : []))
}

/**
 * Tell the tools the person uses about the board's MCP server, in the project's
 * own files — what `kanbo connect <clients> --project --no-instructions` does.
 *
 * Only the ones they named, and only when the tool does not already know: a
 * `kanbo` entry that is already there belongs to them — it may point at
 * a different binary or carry arguments of its own — and is rewritten only
 * when it is kanbo's own and no longer starts.
 *
 * A project file is shared across machines, so it gets the portable form on every system.
 */
async function planMcpServers(projectDir: string, clients: McpClient[]): Promise<InitFileChange[]> {
  const plan = await planConnect(clients.map(agent => ({ agent, instructions: null, mcp: 'project' })), { projectDir })
  return plan.items.flatMap(item => (item.kind === 'mcp' ? [{ kind: 'mcp' as const, change: item.change }] : []))
}

export function describeInit(plan: InitPlan, applied: AppliedInitPlan, options: InitOptions): CliResult {
  const { workspace, target } = plan
  const outcome = ({ path, state }: FileOutcome): FileOutcome => ({ path, state })
  const instructions = applied.files.filter(file => file.kind === 'instructions').map(outcome)[0] ?? null
  const mcp = applied.files.filter(file => file.kind === 'mcp').map(outcome)

  const lines = [`Bound this project to ${workspace.name} — ${applied.bindingPath}`]
  if (target.kind === 'postgres') {
    lines.push(`Board: ${maskDatabaseUrl(target.url)}`)
  }
  else if (target.owner === 'kanbo') {
    lines.push(`Board file: ${target.path}`)
  }
  if (applied.columns.length > 0) {
    lines.push(`Columns: ${applied.columns.join(', ')}`)
  }
  if (instructions) {
    lines.push(`Instructions: ${instructions.path} (${instructions.state})`)
  }
  for (const entry of mcp) {
    lines.push(`MCP: ${entry.path} (${entry.state})`)
  }
  for (const entry of applied.connect) {
    const who = entry.agents.map(agent => AGENTS[agent].label).join(', ')
    lines.push(entry.state === 'manual'
      ? describeManualOutcome(who, entry)
      : `${who}: ${entry.path} (${entry.state === 'ran' ? `ran ${entry.command}` : entry.state})`)
  }
  if (applied.firstCard) {
    lines.push(`First card: ${applied.firstCard.id} ${applied.firstCard.title}`)
  }
  const warning = mcp.length > 0 ? mcpLaunchSpec({ scope: 'project' }).warning : undefined
  if (warning) {
    lines.push(`Note: ${warning}`)
  }
  for (const note of plan.connect?.notes ?? []) {
    lines.push(`Note: ${note}`)
  }
  const connected = instructions !== null || mcp.length > 0 || applied.connect.length > 0
  const launchWarning = connected ? readLaunchWarning() : null
  if (launchWarning) {
    lines.push(`Note: ${launchWarning}`)
  }
  if (!connected) {
    lines.push(CONNECT_LATER_TIP)
  }

  return {
    value: {
      binding: applied.bindingPath,
      workspaceId: workspace.id,
      boardId: options.board ?? null,
      database: describeTarget(target),
      instructions,
      mcp,
      columns: applied.columns,
      connect: applied.connect,
      firstCard: applied.firstCard,
    },
    text: lines.join('\n'),
  }
}

function parseInstructions(value: string): InstructionTarget {
  if (value !== 'claude' && value !== 'agents' && value !== 'none') {
    throw new CliError(1, `Unknown instructions target "${value}". Use claude, agents or none.`)
  }
  return value
}

function parseMcpClients(value: string): McpClient[] {
  return value.split(',').map(name => name.trim()).filter(name => name.length > 0).map((name) => {
    const client = MCP_CLIENTS.find(candidate => candidate === name)
    if (!client) {
      throw new CliError(1, `Unknown MCP client "${name}". Use one or more of ${MCP_CLIENTS.join(', ')}.`)
    }
    return client
  })
}

/** `--key`: a letter and two letters or digits, upper-cased. */
function parseKey(value: string): string {
  if (!isValidCardKey(value)) {
    throw new CliError(1, `"${value}" can't be a card key: use a letter and two letters or digits, like MYA.`)
  }
  return value.trim().toUpperCase()
}

/**
 * `--columns`: a template by name, or the columns in board order — each a
 * ready-made one (`QA`, `Blocked`, …) or a name of the person's own. To Do has
 * to be there: agents take their work from it.
 */
export function parseColumns(value: string): ColumnSpec[] {
  const template = COLUMN_TEMPLATE_IDS.find(id => id === value.trim().toLowerCase())
  if (template) {
    return [...COLUMN_TEMPLATES[template]]
  }
  const names = value.split(',').map(name => name.trim()).filter(Boolean)
  const columns = names.map(name => findCatalogueColumn(name) ?? ownColumn(name, null))
  const slugs = columns.map(column => normalizeStatusName(column.name))
  const repeated = slugs.find((slug, index) => slugs.indexOf(slug) !== index)
  if (repeated) {
    throw new CliError(1, `The column "${columns[slugs.indexOf(repeated)]!.name}" is named twice in --columns.`)
  }
  if (!hasReadyColumn(columns)) {
    throw new CliError(1, `--columns needs To Do: agents take their work from it. Use ${COLUMN_TEMPLATE_IDS.join(', ')}, `
      + 'or a list like "To Do, In Progress, Done".')
  }
  return columns
}

/** `--connect`: agents by name, `all`, or `none`. */
function parseConnect(value: string): AgentId[] {
  const names = value.split(',').map(name => name.trim().toLowerCase()).filter(Boolean)
  if (names.length === 1 && names[0] === 'none') {
    return []
  }
  const agents = names.flatMap((name) => {
    if (name === 'all') {
      return [...AGENT_IDS]
    }
    const agent = parseAgentId(name)
    if (!agent) {
      throw new CliError(1, `Unknown agent "${name}" in --connect. Use ${CONNECT_VALUES}.`)
    }
    return [agent]
  })
  return [...new Set(agents)]
}

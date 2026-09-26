import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'

import type { Command } from 'commander'

import { DEFAULT_BOARD_FILE_PATH } from '../../default-board-file-path'
import { maskDatabaseUrl } from '../../domain/database-url'
import type { BoardWorkspaceIdentity } from '../../domain/numbering'
import { migrateBoardFile } from '../../sqlite/migrate'
import type { BoardFileContents } from '../../sqlite/open-database'
import { markBoardFileOwnedByKanbo, openBoardDatabase, readBoardFileContents } from '../../sqlite/open-database'
import type { SqliteDatabase } from '../../sqlite/transaction'
import type { KanboBinding } from '../binding'
import { ignoreBoardFile, readProjectBinding, writeBinding } from '../binding'
import type { BoardCommandOptions } from '../command'
import { runBoardCommand } from '../command'
import type { BoardTarget } from '../db-target'
import { describeTarget, resolveDatabaseUrl, resolveDbTarget, resolveHostDbPath } from '../db-target'
import type { CliResult } from '../output'
import { CliError, EXIT_NOT_RESOLVED, printResult, readFormat } from '../output'
import { resolveWorkspace } from '../workspace'

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
 */

/** The markers that make the instruction block something this tool can find again. */
const INSTRUCTION_START = '<!-- KANBO_START -->'
const INSTRUCTION_END = '<!-- KANBO_END -->'

/** The files an agent reads its standing instructions from. */
const INSTRUCTION_FILES = { claude: 'CLAUDE.md', agents: 'AGENTS.md' } as const

/** The tools that can be told about the board's MCP server. */
const MCP_CLIENTS = ['claude', 'codex', 'cursor'] as const

/** The name the board's MCP server is registered under, in every tool. */
const MCP_SERVER_NAME = 'kanbo'

/**
 * What a person is told when an external board is named and nothing says which
 * workspace it is about. There is no table to look the answer up in, and a card
 * numbered under a guess carries that guess for the rest of its life.
 */
const EXTERNAL_WORKSPACE_MESSAGE
  = 'Could not tell which workspace this project is, and an external board holds no workspaces table to look '
    + 'it up in. Run this again with --workspace <id> --identifier <KEY>, or with --db (or KANBO_DB_PATH) naming '
    + 'a host database that knows this project.'

/** What a person is told when a board file of the project's own and an external one are both named at once. */
const FILE_AND_DATABASE_URL_MESSAGE
  = 'One board at a time: pass --file for a board file of this project\'s own or --database-url for an external '
    + 'board, not both.'

/**
 * What a person is told when their agents are about to reach the board as its
 * owner. Not a refusal: the board works this way from the first minute, and the
 * rule an agent is missing is one the database keeps, not this command.
 */
const AGENT_URL_MISSING_WARNING
  = 'kanbo: agents in this project will reach the board with the connection string you gave, which owns it. '
    + 'Until you run "kanbo roles apply" and record the agent role\'s own string with --agent-url, an agent '
    + 'here can approve its own work.'

/**
 * The Codex table this command writes, in every spelling TOML allows for the
 * key: bare, double-quoted and single-quoted all name the same server, and a
 * check that only knew the bare one would write a second table beside a
 * registration the person already has.
 */
const CODEX_TABLE_PATTERN = new RegExp(
  String.raw`^\s*\[\s*mcp_servers\s*\.\s*(?:${MCP_SERVER_NAME}|"${MCP_SERVER_NAME}"|'${MCP_SERVER_NAME}')\s*\]`,
  'm',
)

type InstructionTarget = keyof typeof INSTRUCTION_FILES | 'none'
type McpClient = typeof MCP_CLIENTS[number]

/**
 * What an agent working in this project is told about the board.
 *
 * It says what to run and when, and nothing about how to do the work: the
 * method is the person's own instructions to their agent, and the board only
 * insists on the part that keeps the card honest.
 */
export const INSTRUCTION_BLOCK = [
  INSTRUCTION_START,
  '## Kanbo board',
  '',
  'Work on this project is tracked on a kanbo board. Before starting a task run `kanbo prime` —'
  + ' it prints the board\'s columns and what each one means.',
  '',
  '- Take a card from `kanbo ready`.',
  '- Move the card yourself (`kanbo card move <id> <column>`) — a card in the wrong column is a lie.',
  '- Write a status line at every step (`kanbo card status-line <id> --text "..."`).',
  '- Create subtasks only when the person asks for them, or when a task has parts that can be done and checked separately (different stages, owners or pull requests); do not split small work you will finish in one go. When you do split a card, make the parts subtasks of it (the parent card\'s id), not separate top-level cards.'
  + ' (`kanbo card create --description "..." --parent <id>`).',
  '- Findings, decisions and questions go on the card (`kanbo card comment <id> --content "..."`).',
  '- When you need a person, run `kanbo card wait-approval <id>` and end your turn. Never approve your own'
  + ' work, and never take a card out of a column where it is waiting for a person.',
  '- Started the work yourself, not launched by an app that tracks the run? Pass your own session to'
  + ' `kanbo run start --session` —'
  + ' `claude:<session id>` from Claude Code, `codex:<session id>` from Codex (the session id Codex prints).',
  '- Run `kanbo capabilities` for the full list of tools, commands and rules.',
  INSTRUCTION_END,
].join('\n')

interface InitOptions extends BoardCommandOptions {
  board?: string
  identifier?: string
  agentUrl?: string
  instructions?: InstructionTarget
  mcp?: McpClient[]
  yes?: boolean
  /**
   * `--file` with no value parses to `true` (commander's rule for an optional
   * option argument); `--file <path>` parses to that path, relative to the
   * project root.
   */
  file?: string | boolean
}

/** What happened to one file this command may write. */
interface FileOutcome {
  path: string
  /** `written` when the file changed, `unchanged` when it already said this. */
  state: 'written' | 'unchanged'
}

export function registerInitCommand(program: Command): void {
  // Not `withBoardOptions`: `--db` means something else here, and the two
  // board flags stand together rather than refusing each other. The rest is
  // spelled the same as everywhere else.
  program
    .command('init')
    .description('bind this project to a board, and tell its agents about it')
    .option('--db <path>', 'host database file to read this project\'s workspace from')
    .option('--database-url <url>', 'external Postgres board to bind this project to')
    .option('--file [path]', `use a board file of this project's own instead of a host database or an `
    + `external board (default ${DEFAULT_BOARD_FILE_PATH})`)
    .option('--workspace <nameOrId>', 'workspace this project is')
    .option('--json <fields>', 'print only these comma-separated fields, as JSON')
    .option('--format <format>', 'output format: json or pretty')
    .option('--board <id>', 'the board inside the workspace, when it has more than one')
    .option('--identifier <key>', 'what this workspace\'s card keys start with, for an external board')
    .option('--agent-url <url>', 'the connection string agents get, when it is not the one above')
    .option('--instructions <file>', 'where to write the instruction block: claude, agents or none', parseInstructions)
    .option('--mcp <clients>', `register the board's MCP server with ${MCP_CLIENTS.join(', ')}`, parseMcpClients)
    .option('--yes', 'take the defaults instead of asking')
    .action(async (options: InitOptions) => {
      const projectDir = process.cwd()
      if (options.file !== undefined) {
        await initOwnFile(projectDir, options)
        return
      }
      const target = resolveInitTarget(projectDir, options)

      if (target.kind === 'postgres') {
        await initExternalBoard(projectDir, target, options)
        return
      }
      await runBoardCommand(options, 'read', async session => await initProject(
        projectDir,
        target,
        session.workspace,
        options,
      ))
    })
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
 * Bind a project to an external board.
 *
 * The board is never opened. `init` is what a person runs *before*
 * `kanbo migrate`, and a database that holds no board yet is not a reason to
 * refuse to write down where it will be — nor could it answer the one question
 * that matters here, since it has no `workspaces` table to be asked.
 */
async function initExternalBoard(
  projectDir: string,
  target: Extract<BoardTarget, { kind: 'postgres' }>,
  options: InitOptions,
): Promise<void> {
  readFormat(options)
  const workspace = await resolveExternalWorkspace(projectDir, options)
  printResult(await initProject(projectDir, target, workspace, options), options)
}

/**
 * Create and use a board file of this project's own — `.kanbo/board.db` by
 * default — with no host app and no Postgres anywhere near it.
 *
 * The file is migrated with this package's own chain right here, because
 * nothing else ever will: a host app migrates its own database and an
 * external database is migrated by `kanbo migrate`, but a file of this
 * package's own has no other owner to do it later — `kanbo migrate` runs the
 * same chain again afterwards, and idempotently, for the day it falls behind a
 * newer build (ruling 5-5). The marker written right after is what every later
 * command reads to know not to look for a host `workspaces` table in it
 * (ruling 5-4).
 *
 * The workspace is settled before a single byte is written, and nothing here
 * opens a host database at all (ruling 5-9): this is the one command that has
 * to work on a machine with nothing else installed, and the answer it needs —
 * an id and a card-key stem — is either typed, already in the binding, or the
 * folder's own name. Asking a host database first would turn `--workspace <id>`
 * into a refusal on every machine that has one, and leave a board file behind
 * with no binding beside it.
 */
async function initOwnFile(projectDir: string, options: InitOptions): Promise<void> {
  readFormat(options)
  if (options.databaseUrl) {
    throw new CliError(1, FILE_AND_DATABASE_URL_MESSAGE)
  }

  const relativePath = typeof options.file === 'string' && options.file.trim() ? options.file.trim() : DEFAULT_BOARD_FILE_PATH
  const absolutePath = resolve(projectDir, relativePath)
  const workspace = resolveOwnFileWorkspace(projectDir, options)

  await createOwnBoardFile(absolutePath)
  ignoreBoardFile(projectDir, absolutePath)

  const target: BoardTarget = { kind: 'sqlite', path: absolutePath, owner: 'kanbo' }
  printResult(await initProject(projectDir, target, workspace, options), options)
}

/**
 * Put a migrated, marked board at this path — or leave the folder exactly as it
 * was found (ruling 5-9).
 *
 * A new board is built beside its own path and moved onto it at the end, so a
 * migration that fails half-way leaves no half-built file for the next command
 * to open and believe in. `rename` within one directory is the filesystem's own
 * atomic swap; a temporary name elsewhere would be a copy across devices and
 * not atomic at all. A file that is already there is a different question — it
 * may hold this project's cards — so it is migrated in place, idempotently,
 * which is what makes a second `kanbo init --file` a no-op.
 *
 * A file that is there and is *not* this package's is refused, for the reason
 * any careful host refuses it: migrating a board into somebody's own
 * database leaves it readable but contaminated, and only a different path
 * helps.
 */
async function createOwnBoardFile(absolutePath: string): Promise<void> {
  mkdirSync(dirname(absolutePath), { recursive: true })
  if (existsSync(absolutePath)) {
    assertOwnBoardFile(absolutePath)
    await migrateBoardFileAt(absolutePath)
    return
  }

  const temporaryPath = `${absolutePath}.${process.pid}.tmp`
  try {
    await migrateBoardFileAt(temporaryPath)
    renameSync(temporaryPath, absolutePath)
  }
  catch (error) {
    // Its WAL siblings too: SQLite removes them on a clean close, and a close
    // is exactly what a failure half-way through may not have reached.
    for (const leftover of [temporaryPath, `${temporaryPath}-wal`, `${temporaryPath}-shm`]) {
      rmSync(leftover, { force: true })
    }
    throw error
  }
}

/** Refuse a file already at the board's path that this package did not write. */
function assertOwnBoardFile(absolutePath: string): void {
  let contents: BoardFileContents
  try {
    contents = readBoardFileContents(absolutePath)
  }
  catch {
    throw new CliError(1, notABoardFileMessage(absolutePath))
  }
  if (!contents.empty && contents.owner !== 'kanbo') {
    throw new CliError(1, notABoardFileMessage(absolutePath))
  }
}

function notABoardFileMessage(absolutePath: string): string {
  return `${absolutePath} already holds a database of its own. Name another path with --file, `
    + 'or move that file out of the way.'
}

async function migrateBoardFileAt(path: string): Promise<void> {
  const board = await openBoardDatabase(path)
  try {
    migrateBoardFile(board.database)
    markBoardFileOwnedByKanbo(board.database)
  }
  finally {
    board.close()
  }
}

/** The three things `init` writes, whichever kind of board it was given. */
async function initProject(
  projectDir: string,
  target: BoardTarget,
  workspace: BoardWorkspaceIdentity,
  options: InitOptions,
): Promise<CliResult> {
  warnAboutOwnerAccess(target, options)
  const bindingPath = writeBinding(projectDir, buildBinding(projectDir, target, workspace, options))
  const instructions = await writeInstructions(projectDir, options)
  const mcp = await registerMcpServers(projectDir, options)

  return {
    value: {
      binding: bindingPath,
      workspaceId: workspace.id,
      boardId: options.board ?? null,
      database: describeTarget(target),
      instructions,
      mcp,
    },
    text: describeInit(workspace, target, bindingPath, instructions, mcp),
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
  return {
    local,
    id: local?.id ?? options.workspace?.trim(),
    identifier: options.identifier?.trim() || local?.identifier,
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
async function resolveExternalWorkspace(projectDir: string, options: InitOptions): Promise<BoardWorkspaceIdentity> {
  const guess = await guessWorkspace(projectDir, options)
  if (!guess.id || !guess.identifier) {
    throw new CliError(EXIT_NOT_RESOLVED, EXTERNAL_WORKSPACE_MESSAGE)
  }
  return { id: guess.id, identifier: guess.identifier, name: guess.local?.id === guess.id ? guess.local.name : guess.identifier }
}

/**
 * The same question, for a board file of this project's own — asked of three
 * things, none of which is a database (ruling 5-9).
 *
 * `kanbo init --file` is the one command this package promises works with
 * nothing else installed, so there is nothing to refuse about it and nothing to
 * look up: what the person typed wins, then the id this project is already
 * bound to, and failing both the folder's own name, slugged, stands in for the
 * id and for the card-key stem `readIssuePrefix` derives from it.
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
function resolveOwnFileWorkspace(projectDir: string, options: InitOptions): BoardWorkspaceIdentity {
  const bound = readProjectBinding(projectDir)
  const slug = deriveProjectSlug(projectDir)
  const id = options.workspace?.trim() || bound?.workspaceId.trim() || slug
  const boundIdentifier = id === bound?.workspaceId.trim() ? bound.identifier?.trim() : null
  const identifier = options.identifier?.trim() || boundIdentifier || slug
  return { id, identifier, name: identifier }
}

/** A workspace id and card-key stem from the project folder's own name, for the machine with nothing else to ask. */
function deriveProjectSlug(projectDir: string): string {
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
 * Put the block in the file the caller named — or, when they named none, show
 * them what it says and ask.
 *
 * A shell that is nobody's terminal is never asked anything: an `init` in a
 * script prints the block and stops there, because writing into a project's
 * instructions is the kind of thing a person says yes to.
 */
async function writeInstructions(projectDir: string, options: InitOptions): Promise<FileOutcome | null> {
  const target = options.instructions ?? await askInstructionTarget(options)
  if (target === 'none') {
    return null
  }
  return writeInstructionBlock(join(projectDir, INSTRUCTION_FILES[target]))
}

async function askInstructionTarget(options: InitOptions): Promise<InstructionTarget> {
  showBlock(options)
  if (options.yes || !isInteractive()) {
    return 'none'
  }

  const prompts = await import('@clack/prompts')
  const answer = await prompts.select({
    message: 'Add this block to the project\'s agent instructions?',
    options: [
      { value: 'claude' as const, label: 'CLAUDE.md' },
      { value: 'agents' as const, label: 'AGENTS.md' },
      { value: 'none' as const, label: 'Neither — I will paste it myself' },
    ],
  })
  return prompts.isCancel(answer) ? 'none' : answer
}

/**
 * Show the block to whoever is about to decide where it goes — unless the
 * caller asked for machine output, in which case stdout belongs to the result
 * and nothing else may be written there, prompt or no prompt.
 */
function showBlock(options: InitOptions): void {
  if (!options.json && !options.format) {
    console.log(`${INSTRUCTION_BLOCK}\n`)
  }
}

/**
 * The block, in that file, once.
 *
 * A file that already carries the markers has its block replaced rather than
 * appended to, so running `init` again on a project whose block is current
 * changes nothing at all, and running it after an upgrade brings the block
 * forward. Everything outside the markers is the person's own writing and is
 * never touched.
 */
function writeInstructionBlock(path: string): FileOutcome {
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : null
  const next = buildInstructionFile(existing)
  if (existing === next) {
    return { path, state: 'unchanged' }
  }
  writeFileSync(path, next)
  return { path, state: 'written' }
}

function buildInstructionFile(existing: string | null): string {
  if (existing === null) {
    return `${INSTRUCTION_BLOCK}\n`
  }

  const start = existing.indexOf(INSTRUCTION_START)
  const end = existing.indexOf(INSTRUCTION_END)
  if (start >= 0 && end > start) {
    return existing.slice(0, start) + INSTRUCTION_BLOCK + existing.slice(end + INSTRUCTION_END.length)
  }
  return `${existing.replace(/\s*$/, '')}\n\n${INSTRUCTION_BLOCK}\n`
}

/**
 * Tell the tools the person uses about the board's MCP server.
 *
 * Only the ones they named, and only when the tool does not already know: a
 * `kanbo` entry that is already there belongs to them — it may point at
 * a different binary or carry arguments of its own — and overwriting it would
 * be this command deciding something it was not asked to decide.
 */
async function registerMcpServers(projectDir: string, options: InitOptions): Promise<FileOutcome[]> {
  const clients = options.mcp ?? await askMcpClients(options)
  return clients.map(client => registerMcpServer(projectDir, client))
}

async function askMcpClients(options: InitOptions): Promise<McpClient[]> {
  if (options.yes || !isInteractive()) {
    return []
  }

  const prompts = await import('@clack/prompts')
  const answer = await prompts.multiselect({
    message: 'Register the board\'s MCP server with which tools?',
    options: [
      { value: 'claude' as const, label: 'Claude Code (.mcp.json)' },
      { value: 'codex' as const, label: 'Codex (.codex/config.toml)' },
      { value: 'cursor' as const, label: 'Cursor (.cursor/mcp.json)' },
    ],
    required: false,
  })
  return prompts.isCancel(answer) ? [] : answer
}

function registerMcpServer(projectDir: string, client: McpClient): FileOutcome {
  if (client === 'codex') {
    return writeCodexMcpServer(join(projectDir, '.codex', 'config.toml'))
  }
  return writeJsonMcpServer(join(projectDir, ...(client === 'claude' ? ['.mcp.json'] : ['.cursor', 'mcp.json'])))
}

/**
 * The `mcpServers` map Claude Code and Cursor both read, merged rather than
 * replaced: the file is the project's, and it may already describe servers that
 * have nothing to do with this board.
 */
function writeJsonMcpServer(path: string): FileOutcome {
  const existing = readJsonFile(path)
  if (existing.mcpServers && MCP_SERVER_NAME in existing.mcpServers) {
    return { path, state: 'unchanged' }
  }

  const next = {
    ...existing,
    mcpServers: { ...existing.mcpServers, [MCP_SERVER_NAME]: { type: 'stdio', command: 'kanbo', args: ['mcp'] } },
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`)
  return { path, state: 'written' }
}

/**
 * The tool's configuration file as an object to merge into — or a refusal.
 *
 * A file that is valid JSON but not an object (a list, a string, `null`) is
 * something this command has no idea how to merge into, and spreading it would
 * quietly throw the person's file away. The file is left exactly as it is and
 * they are told which one to look at.
 */
function readJsonFile(path: string): { mcpServers?: Record<string, unknown> } {
  if (!existsSync(path)) {
    return {}
  }

  const parsed = parseJsonFile(path)
  if (!isPlainObject(parsed)) {
    throw new CliError(1, `${path} does not hold a JSON object. Fix or remove it, then run kanbo init again.`)
  }
  if (parsed.mcpServers !== undefined && !isPlainObject(parsed.mcpServers)) {
    throw new CliError(1, `${path} has an "mcpServers" that is not an object. Fix it, then run kanbo init again.`)
  }
  return parsed as { mcpServers?: Record<string, unknown> }
}

function parseJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  }
  catch {
    throw new CliError(1, `${path} is not valid JSON. Fix or remove it, then run kanbo init again.`)
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Codex keeps its servers in TOML tables, so the table is appended rather than merged. */
function writeCodexMcpServer(path: string): FileOutcome {
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const table = `[mcp_servers.${MCP_SERVER_NAME}]\ncommand = "kanbo"\nargs = ["mcp"]\n`
  if (CODEX_TABLE_PATTERN.test(existing)) {
    return { path, state: 'unchanged' }
  }

  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, existing.trim() ? `${existing.replace(/\s*$/, '')}\n\n${table}` : table)
  return { path, state: 'written' }
}

/** Is there a person on the other end of this shell to ask? */
function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY)
}

function describeInit(
  workspace: BoardWorkspaceIdentity,
  target: BoardTarget,
  bindingPath: string,
  instructions: FileOutcome | null,
  mcp: FileOutcome[],
): string {
  const lines = [`Bound this project to ${workspace.name} — ${bindingPath}`]
  if (target.kind === 'postgres') {
    lines.push(`Board: ${maskDatabaseUrl(target.url)}`)
  }
  else if (target.owner === 'kanbo') {
    lines.push(`Board file: ${target.path}`)
  }
  if (instructions) {
    lines.push(`Instructions: ${instructions.path} (${instructions.state})`)
  }
  for (const outcome of mcp) {
    lines.push(`MCP: ${outcome.path} (${outcome.state})`)
  }
  return lines.join('\n')
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

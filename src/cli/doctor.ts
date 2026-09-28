import { existsSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import type { BoardStore } from '../board-store'
import { COLUMN_TEMPLATES } from '../domain/column-templates'
import { maskDatabaseUrl } from '../domain/database-url'
import { BoardError } from '../domain/errors'
import { createBoardOps } from '../ops'
import { KANBO_PACKAGE_VERSION } from '../package-version'
import { createPostgresBoardStore } from '../postgres/board-store.postgres'
import { createSqliteBoardStore } from '../sqlite/board-store.sqlite'
import { migrateBoardFile } from '../sqlite/migrate'
import { assertBoardSchema, openBoardDatabase } from '../sqlite/open-database'
import { readAgentShellMarker } from './agent-shell'
import type { KanboBinding } from './binding'
import { BINDING_FILE_PATH, readBinding } from './binding'
import type { BoardTarget } from './db-target'
import { resolveDbTarget } from './db-target'
import { describeFailure } from './failure'
import { openPostgresBoard } from './postgres-board'
import { assertInstalledBoard, assertWritableBoard, FILE_SCHEMA_OUTDATED_MESSAGE, SCHEMA_OUTDATED_MESSAGE } from './schema-guard'
import type { AgentId } from './setup/agents'
import { AGENT_IDS, AGENTS, instructionPaths } from './setup/agents'
import type { AgentRequest, ConnectPlan } from './setup/connect-plan'
import { applyConnectPlan, describeConnectItems, describeManualOutcome, displayPath, pendingItems, planConnect, readMcpEntry } from './setup/connect-plan'
import type { InstructionBlockInspection } from './setup/instructions'
import { damagedBlockMessage, GLOBAL_INSTRUCTION_BLOCK, INSTRUCTION_BLOCK, readInstructionBlockInspection } from './setup/instructions'
import type { McpEntry } from './setup/mcp-config'
import { canStartMcpEntry, isOwnMcpEntry, isStaleMcpEntry, MCP_ARGS, MCP_COMMAND } from './setup/mcp-config'
import { isNpxScript, NOT_INSTALLED_FIX } from './setup/launch-warning'
import { resolveShimTarget } from './setup/npm-shim'
import { findAllOnPath, findOnPath } from './setup/paths'
import type { UpdateCheck } from './update-check'
import { UPDATE_COMMAND } from './update-check'

/**
 * `kanbo doctor` — the checks for the ways kanbo can be set up wrong without
 * any command saying so: a binding nobody can read, a board older than this
 * build, an instruction block written by an older kanbo, an MCP registration
 * whose command a client cannot start, a server that does not answer, another
 * `kanbo` earlier on `PATH`, a person's own shell marked as an agent's.
 *
 * Every check says `ok`, `info`, `warn` or `fail`, and every one that is not
 * `ok` carries the command or edit that fixes it. Nothing here writes
 * anything: a finding that `kanbo doctor --fix` can put right carries the
 * `repair` that would, worked out in full, and only that command applies it.
 */

export type DoctorStatus = 'ok' | 'info' | 'warn' | 'fail'

export interface DoctorFinding {
  check: string
  status: DoctorStatus
  detail: string
  /** What to do about it, on every finding that is not `ok`. */
  fix?: string
  /** What `kanbo doctor --fix` would do about it; absent when it is not kanbo's to fix. */
  repair?: DoctorRepair
}

/**
 * One fix `kanbo doctor --fix` can make: files kanbo writes (never deletes),
 * commands it runs, a board it migrates or gives columns — only ever what is
 * kanbo's own, by the same rules `kanbo connect` goes by.
 */
export interface DoctorRepair {
  /** Its lines in the plan the person says yes to, as `kanbo connect` shows one: `  write  CLAUDE.md (…)`. */
  plan: string[]
  /** Carry it out; one line for each thing that happened. */
  apply: () => Promise<string[]>
}

export interface DoctorInput {
  /** The folder the doctor was run in; the project is looked for at or above it. */
  cwd: string
  /** The script this `kanbo` is running from, to tell it apart from another one on `PATH`. */
  self: string | null
  /** How long the MCP server may take to answer `initialize`. */
  handshakeTimeoutMs: number
  /** The OS whose rules a registration is checked by; defaults to this process's. */
  platform?: NodeJS.Platform
  /** The update check started for this run (`update-check.ts`); `null` or absent when it is skipped. */
  update?: UpdateCheck | null
}

/** How long an external board may take to answer before the doctor gives up on it. */
const POSTGRES_TIMEOUT_MS = 5_000

/** A project folder: the one with `.kanbo/` in it, and the binding that folder has, if any. */
export interface ProjectState {
  root: string
  binding: KanboBinding | null
}

/** One MCP registration found in a tool's configuration. */
interface Registration extends McpEntry {
  client: AgentId
  path: string
  /** The project's shared file, or the person's own configuration. */
  scope: 'project' | 'user'
}

export async function collectDoctorFindings(input: DoctorInput): Promise<DoctorFinding[]> {
  const findings: DoctorFinding[] = [
    { check: 'version', status: 'ok', detail: `kanbo ${KANBO_PACKAGE_VERSION}${input.self ? ` (${input.self})` : ''}` },
    ...checkInstall(input.self),
    checkPath(input.self),
  ]

  const project = findKanboProject(input.cwd)
  findings.push(checkProject(project))
  const target = project?.binding ? resolveTarget(project.root) : null
  if (project?.binding && !project.binding.databaseUrl) {
    findings.push(await checkSqlite())
  }
  if (project?.binding && findings.every(finding => finding.check !== 'sqlite' || finding.status === 'ok')) {
    findings.push(...await checkBoard(target, project.binding.workspaceId, project.root))
  }

  findings.push(...await checkInstructions(project?.root ?? null))

  const platform = input.platform ?? process.platform
  const registrations = findRegistrations(project?.root ?? null)
  findings.push(...await checkRegistrations(registrations, platform, project?.root ?? input.cwd))
  if (project?.binding && !(target instanceof Error)) {
    findings.push(await checkHandshake(registrations, project.root, input.handshakeTimeoutMs, platform))
  }

  findings.push(checkActor())

  // By now npm has had as long as the checks took; like after any command, it
  // gets ~300 ms more at most. A second round (`--fix`) gets the same answer at once.
  const update = await input.update?.settle()
  if (update) {
    findings.splice(1, 0, {
      check: 'update',
      status: 'info',
      detail: `kanbo ${update.latest} is available (you have ${update.current}).`,
      fix: `Update kanbo: ${UPDATE_COMMAND}`,
    })
  }
  return findings
}

/** A kanbo run from npx lives in npm's cache for one command: agents cannot start it. */
function checkInstall(self: string | null): DoctorFinding[] {
  if (!self || !isNpxScript(self)) {
    return []
  }
  return [{
    check: 'install',
    status: 'warn',
    detail: 'kanbo runs from npx\'s cache: it is gone once this command ends, and agents cannot start kanbo mcp from it.',
    fix: `Install kanbo globally: ${NOT_INSTALLED_FIX}`,
  }]
}

/** Is the `kanbo` a client would start this one? */
function checkPath(self: string | null): DoctorFinding {
  const all = findAllOnPath(MCP_COMMAND)
  if (all.length === 0) {
    return {
      check: 'path',
      status: 'warn',
      detail: 'No kanbo on PATH: a shell or MCP client that runs `kanbo` will not find it.',
      fix: 'Run npm install -g kanbo-cli, or put the directory that holds kanbo on PATH.',
    }
  }
  const first = all[0]!
  // On Windows the first match is npm's `.cmd` shim; the script it starts is what `self` is.
  const started = resolveShimTarget(first) ?? first
  if (self && realPath(started) !== realPath(self)) {
    return {
      check: 'path',
      status: 'warn',
      detail: `${first} comes first on PATH and is not this kanbo (${self}): agents and MCP clients start that one.`,
      fix: 'Remove the other install, or put this one first on PATH.',
    }
  }
  return { check: 'path', status: 'ok', detail: `kanbo on PATH: ${first}` }
}

/** The nearest folder at or above `cwd` with a `.kanbo/` directory, and its binding. */
export function findKanboProject(cwd: string): ProjectState | null {
  let directory = resolve(cwd)
  while (true) {
    const kanboDirectory = join(directory, dirname(BINDING_FILE_PATH))
    if (existsSync(kanboDirectory) && statSync(kanboDirectory).isDirectory()) {
      return { root: directory, binding: readBinding(join(directory, BINDING_FILE_PATH)) }
    }
    const parent = dirname(directory)
    if (parent === directory) {
      return null
    }
    directory = parent
  }
}

function checkProject(project: ProjectState | null): DoctorFinding {
  if (!project) {
    return {
      check: 'settings',
      status: 'warn',
      detail: 'Not inside a kanbo project (no .kanbo/ here or above); board checks are skipped.',
      fix: 'Run kanbo init in a project to give it a board.',
    }
  }
  const path = join(project.root, BINDING_FILE_PATH)
  if (!project.binding) {
    return {
      check: 'settings',
      status: 'fail',
      detail: existsSync(path)
        ? `This build can't read the project settings in ${path}.`
        : `${join(project.root, dirname(BINDING_FILE_PATH))} has no ${BINDING_FILE_PATH.split(/[\\/]/).pop()}: nothing says which board this project is on.`,
      fix: `Run kanbo init (with --file, or the --database-url you used) in ${project.root} to write its project settings again.`,
    }
  }
  return { check: 'settings', status: 'ok', detail: `Project settings ${path}: workspace ${project.binding.workspaceId}` }
}

function resolveTarget(root: string): BoardTarget | Error {
  try {
    return resolveDbTarget({ cwd: root })
  }
  catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}

/** The native module a board file needs, loaded on a database of its own in memory. */
async function checkSqlite(): Promise<DoctorFinding> {
  try {
    (await openBoardDatabase(':memory:')).close()
    return { check: 'sqlite', status: 'ok', detail: 'better-sqlite3 loads.' }
  }
  catch (error) {
    return {
      check: 'sqlite',
      status: 'fail',
      detail: `better-sqlite3 cannot be loaded: ${describeFailure(error).message}`,
      fix: 'Reinstall kanbo: npm install -g kanbo-cli',
    }
  }
}

/**
 * The board itself: it opens, its schema is this build's, and — on a board
 * kanbo owns — it has columns for agents to take work from.
 */
async function checkBoard(target: BoardTarget | Error | null, workspaceId: string, root: string): Promise<DoctorFinding[]> {
  if (target === null) {
    return []
  }
  if (target instanceof Error) {
    return [{ check: 'board', status: 'fail', detail: describeFailure(target).message, fix: 'Run kanbo init in the project to give it a board.' }]
  }
  if (target.kind === 'postgres') {
    return await checkPostgresBoard(target.url, workspaceId)
  }

  const board = await openBoardDatabase(target.path)
  const ownFile = target.owner === 'kanbo'
  const shown = displayPath({ projectDir: root }, target.path)
  try {
    assertBoardSchema(board.database)
  }
  catch (error) {
    const outdated = error instanceof BoardError && error.code === 'board_schema_outdated'
    // Tables or columns a later migration adds are what `kanbo migrate` brings; a file of another epoch it cannot.
    const migratable = ownFile && outdated && !('expected' in ((error as BoardError).details ?? {}))
    return [{
      check: 'board',
      status: 'fail',
      detail: outdated
        ? `${target.path}: ${ownFile ? FILE_SCHEMA_OUTDATED_MESSAGE : SCHEMA_OUTDATED_MESSAGE}`
        : `${target.path}: ${describeFailure(error).message}`,
      fix: migratable ? 'Run kanbo doctor --fix, or kanbo migrate.' : ownFile ? 'Run kanbo migrate.' : 'Start the app this database belongs to, so it applies its migrations.',
      ...(migratable
        ? {
            repair: {
              plan: [`  migrate  ${shown} (brings the board's tables up to this kanbo's schema; every card stays)`],
              apply: async () => {
                const opened = await openBoardDatabase(target.path)
                try {
                  migrateBoardFile(opened.database)
                }
                finally {
                  opened.close()
                }
                return [`migrated ${shown}`]
              },
            },
          }
        : {}),
    }]
  }
  finally {
    board.close()
  }

  const findings: DoctorFinding[] = [{ check: 'board', status: 'ok', detail: `${target.path} opens; its schema is current.` }]
  if (ownFile) {
    const counted = await openBoardDatabase(target.path)
    try {
      const store = createSqliteBoardStore({ database: () => counted.database })
      findings.push(...await checkColumns(store, workspaceId, async () => {
        const opened = await openBoardDatabase(target.path)
        assertWritableBoard(opened.database, target.owner)
        return { store: createSqliteBoardStore({ database: () => opened.database }), close: async () => opened.close() }
      }))
    }
    finally {
      counted.close()
    }
  }
  return findings
}

/** The Standard columns, as the plan names them. */
const STANDARD_COLUMN_NAMES = COLUMN_TEMPLATES.standard.map(column => column.name).join(', ')

/**
 * A board with no columns gives agents nothing to take: `kanbo prime` lists
 * none and `kanbo ready` has no To Do. Boards from kanbo 0.1–0.2 got their
 * columns only with the first card.
 */
async function checkColumns(
  store: BoardStore,
  workspaceId: string,
  open: () => Promise<{ store: BoardStore, close: () => Promise<void> }>,
): Promise<DoctorFinding[]> {
  if (await store.statuses.countByWorkspace(workspaceId) > 0) {
    return []
  }
  return [{
    check: 'columns',
    status: 'warn',
    detail: 'This board has no columns: kanbo prime shows agents none, and kanbo ready has no To Do to take cards from.',
    fix: 'Run kanbo doctor --fix, or kanbo columns template standard.',
    repair: {
      plan: [`  add    the Standard columns to the board: ${STANDARD_COLUMN_NAMES}`],
      apply: async () => {
        const board = await open()
        try {
          const { added } = await createBoardOps(board.store).applyColumnTemplate(workspaceId, COLUMN_TEMPLATES.standard, { mode: 'seed' })
          return [added.length > 0 ? `added the columns ${added.join(', ')}` : 'the board already has columns — nothing added']
        }
        finally {
          await board.close()
        }
      },
    },
  }]
}

async function checkPostgresBoard(url: string, workspaceId: string): Promise<DoctorFinding[]> {
  const where = maskDatabaseUrl(url)
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${POSTGRES_TIMEOUT_MS / 1000}s`)), POSTGRES_TIMEOUT_MS)
  })
  try {
    const board = await Promise.race([openPostgresBoard(url), timeout])
    let columns: DoctorFinding[]
    try {
      await Promise.race([assertInstalledBoard(board.database), timeout])
      columns = await Promise.race([checkColumns(createPostgresBoardStore({ database: board.database }), workspaceId, async () => {
        const opened = await openPostgresBoard(url)
        return { store: createPostgresBoardStore({ database: opened.database }), close: opened.close }
      }), timeout])
    }
    finally {
      void board.close()
    }
    return [{ check: 'board', status: 'ok', detail: `${where} answers; its schema is current.` }, ...columns]
  }
  catch (error) {
    return [{ check: 'board', status: 'fail', detail: `${where}: ${describeFailure(error).message}`, fix: 'Check the connection string, then run kanbo migrate.' }]
  }
  finally {
    clearTimeout(timer)
  }
}

/**
 * Every instruction block kanbo could have written, compared with the one this
 * build writes. Only files that carry a block are reported: a file without one
 * is not a fault, but having no block anywhere is worth a warning.
 */
async function checkInstructions(root: string | null): Promise<DoctorFinding[]> {
  const findings: DoctorFinding[] = []
  const scopes = [...(root ? [{ scope: 'project' as const, root, block: INSTRUCTION_BLOCK }] : []), { scope: 'user' as const, root: root ?? process.cwd(), block: GLOBAL_INSTRUCTION_BLOCK }]
  for (const { scope, root: folder, block } of scopes) {
    for (const { path, agents } of instructionPaths(scope, folder)) {
      const inspection = readInstructionBlockInspection(path, block)
      if (inspection !== null) {
        const command = `kanbo connect ${agents[0]} ${scope === 'project' ? '--project' : '--global'} --no-mcp`
        const finding = blockFinding(path, inspection, scope === 'project' ? `cd ${folder} && ${command}` : command)
        if (inspection.state === 'outdated' || inspection.state === 'legacy') {
          // `kanbo connect`'s own plan for this file, so the rewrite is exactly the one it would make.
          finding.repair = connectRepair(await planConnect([{ agent: agents[0]!, instructions: scope, mcp: null }], { projectDir: folder, yes: true }))
        }
        findings.push(finding)
      }
    }
  }
  if (findings.length === 0) {
    findings.push({
      check: 'instructions',
      status: 'warn',
      detail: 'No kanbo instruction block in this project\'s or your own agent files: agents learn the rules only from the MCP server.',
      fix: 'Run kanbo connect in the project (kanbo connect claude --yes, say), or kanbo connect claude --global.',
    })
  }
  return findings
}

/**
 * A block kanbo wrote and nobody changed is only out of date: it still sends
 * the agent to `kanbo prime`, so it is a warning, and `--yes` rewrites it. A
 * block the person changed is theirs, and only they can say to replace it; a
 * text they chose, or a block a newer kanbo wrote, is fine as it is. A file
 * whose markers do not pair up is one kanbo will not touch until it is fixed.
 */
function blockFinding(path: string, inspection: InstructionBlockInspection, command: string): DoctorFinding {
  switch (inspection.state) {
    case 'current':
      return { check: 'instructions', status: 'ok', detail: `${path}: block is current.` }
    case 'chosen':
      return { check: 'instructions', status: 'ok', detail: `${path}: you chose the ${inspection.kind} text for the kanbo section; kanbo leaves it alone.` }
    case 'newer':
      return {
        check: 'instructions',
        status: 'ok',
        detail: `${path}: written by a newer kanbo (v${inspection.version}) — update kanbo: npm install -g kanbo-cli@latest`,
      }
    case 'damaged': {
      const message = damagedBlockMessage(path, inspection.damage!)
      return { check: 'instructions', status: 'fail', detail: message, fix: message }
    }
    case 'edited':
      return {
        check: 'instructions',
        status: 'warn',
        detail: `${path}: you edited the kanbo block, so kanbo leaves it alone.`,
        fix: `Keep it, or run ${command} in a terminal and answer yes to replace it with the current one.`,
      }
    default:
      return {
        check: 'instructions',
        status: 'warn',
        detail: `${path}: block was written by an older kanbo.`,
        fix: `Run kanbo doctor --fix, or ${command} --yes to rewrite it.`,
      }
  }
}

/** Every `kanbo` registration in the project's and the person's own tool configuration. */
function findRegistrations(root: string | null): Registration[] {
  const found: Registration[] = []
  for (const client of AGENT_IDS) {
    const scopes = [...(root ? ['project' as const] : []), 'user' as const]
    for (const scope of scopes) {
      const target = AGENTS[client].mcpTarget(scope, root ?? process.cwd())
      const entry = readMcpEntry(target)
      if (entry !== undefined) {
        found.push({ client, path: target.path, scope, ...entry })
      }
    }
  }
  return found
}

async function checkRegistrations(registrations: Registration[], platform: NodeJS.Platform, projectDir: string): Promise<DoctorFinding[]> {
  if (registrations.length === 0) {
    return [{
      check: 'mcp',
      status: 'warn',
      detail: 'No MCP client has the kanbo server registered.',
      fix: 'Run kanbo connect in the project (kanbo connect claude --yes, say), or kanbo connect claude --global.',
    }]
  }
  const findings: DoctorFinding[] = []
  for (const registration of registrations) {
    const finding = checkRegistration(registration, platform)
    // kanbo's own entry that no longer starts is rewritten the way `kanbo connect` would.
    if (finding.status !== 'ok' && isOwnMcpEntry(registration) && isStaleMcpEntry(registration, registration.scope, platform)) {
      const request: AgentRequest = { agent: registration.client, instructions: null, mcp: registration.scope }
      finding.repair = connectRepair(await planConnect([request], { projectDir, yes: true, platform }))
    }
    findings.push(finding)
  }
  return findings
}

function checkRegistration(registration: Registration, platform: NodeJS.Platform): DoctorFinding {
  const { client, path, command, scope } = registration
  const check = `mcp:${client}`
  if (command === null) {
    return { check, status: 'warn', detail: `${path}: the kanbo entry names no command.`, fix: `Set "command" to kanbo in ${path}.` }
  }
  const cmdShim = codexCannotStart(registration, platform)
  if (!isOwnMcpEntry(registration)) {
    const detail = `${path}: your own kanbo entry (${[command, ...registration.args].join(' ')}) — left as is.`
    if (!cmdShim && canStartMcpEntry(registration, platform)) {
      return { check, status: 'ok', detail }
    }
    return {
      check,
      status: 'warn',
      detail: `${detail} It can't start here.`,
      fix: cmdShim && scope === 'project'
        ? CODEX_PROJECT_CMD_FIX
        : `Change the command in ${path}, or remove the entry and run ${connectCommand(client, scope)}.`,
    }
  }
  if (cmdShim) {
    return {
      check,
      status: 'warn',
      detail: `${path}: starts ${command}, which on Windows is a .cmd shim.`,
      fix: scope === 'project' ? CODEX_PROJECT_CMD_FIX : 'Codex on Windows can\'t start a .cmd — run kanbo doctor --fix, or re-register with `kanbo connect codex`.',
    }
  }
  if (isAbsoluteOn(platform, command)) {
    return checkAbsoluteRegistration({ ...registration, command }, platform)
  }
  const resolved = findOnPath(command, { platform })
  return resolved
    ? { check, status: 'ok', detail: `${path}: starts ${command} (${resolved}).` }
    : {
        check,
        status: 'fail',
        detail: `${path}: starts ${command}, which is not on PATH — the client cannot start the server.`,
        fix: `Run npm install -g kanbo-cli, or change the command in ${path} to a path that exists.`,
      }
}

/** What doctor --fix does about a `kanbo connect` plan; nothing when it changes nothing. */
function connectRepair(plan: ConnectPlan): DoctorRepair | undefined {
  if (pendingItems(plan).length === 0) {
    return undefined
  }
  return {
    plan: describeConnectItems(plan),
    apply: async () => applyConnectPlan(plan).map((outcome) => {
      switch (outcome.state) {
        case 'manual':
          return describeManualOutcome(AGENTS[outcome.agents[0]!].label, outcome)
        case 'ran':
          return `ran ${outcome.command}`
        default:
          return `${outcome.state} ${displayPath(plan, outcome.path)}`
      }
    }),
  }
}

/** A full path by the rules of that OS — a Windows one is `C:\\…` even when the doctor runs elsewhere. */
function isAbsoluteOn(platform: NodeJS.Platform, path: string): boolean {
  return isAbsolute(path) || (platform === 'win32' && isWindowsAbsolute(path))
}

/**
 * A project's Codex entry that Windows cannot start: `kanbo connect codex`
 * alone would register kanbo for the person and leave the project's entry
 * there, so the fix is two commands, each on its own line.
 */
const CODEX_PROJECT_CMD_FIX = 'Codex on Windows can\'t start a .cmd. Remove the project entry, then register kanbo for your user:\n'
  + '  kanbo connect codex --project --remove --no-instructions\n'
  + '  kanbo connect codex'

/**
 * A registration that names its program by full path — on Windows, a Node and
 * the kanbo script it runs. Both have to still be there: a Node upgrade or a
 * reinstall elsewhere leaves the client starting nothing.
 */
function checkAbsoluteRegistration({ client, path, scope, command, args }: Registration & { command: string }, platform: NodeJS.Platform): DoctorFinding {
  const check = `mcp:${client}`
  const missing = [command, ...args.filter(arg => isAbsoluteOn(platform, arg))].filter(file => !existsSync(file))
  if (missing.length > 0) {
    return {
      check,
      status: 'fail',
      detail: `${path}: starts ${[command, ...args].join(' ')}, but ${missing.join(' and ')} ${missing.length === 1 ? 'does' : 'do'} not exist — the client cannot start the server.`,
      fix: `Run kanbo doctor --fix, or ${connectCommand(client, scope)}, to point it at this kanbo.`,
    }
  }
  return { check, status: 'ok', detail: `${path}: starts ${[command, ...args].join(' ')}.` }
}

/**
 * Start the server a client would start, from the project folder, and ask it
 * `initialize`. It has to call itself `kanbo` and send its instructions.
 */
async function checkHandshake(
  registrations: Registration[],
  root: string,
  timeoutMs: number,
  platform: NodeJS.Platform,
): Promise<DoctorFinding> {
  const launch = findStartable(registrations, platform)
  if (!launch) {
    return { check: 'mcp:handshake', status: 'warn', detail: 'No kanbo to start, so the MCP server was not tried.', fix: 'Run npm install -g kanbo-cli.' }
  }
  const command = [launch.command, ...launch.args.slice(0, -1)].join(' ')

  const transport = new StdioClientTransport({ command: launch.command, args: launch.args, cwd: root, env: stringEnvironment(), stderr: 'pipe' })
  let stderr = ''
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  const client = new Client({ name: 'kanbo-doctor', version: KANBO_PACKAGE_VERSION })
  try {
    await client.connect(transport, { timeout: timeoutMs })
    const name = client.getServerVersion()?.name
    const instructions = client.getInstructions()
    if (name !== 'kanbo' || !instructions?.trim()) {
      return {
        check: 'mcp:handshake',
        status: 'fail',
        detail: `${command} mcp answered as ${name ?? 'nothing'}${instructions?.trim() ? '' : ', without instructions'}.`,
        fix: 'Run npm install -g kanbo-cli@latest, and make it the first kanbo on PATH.',
      }
    }
    return { check: 'mcp:handshake', status: 'ok', detail: `${command} mcp answers initialize as kanbo, with instructions.` }
  }
  catch (error) {
    const said = stderr.trim().split('\n')[0]
    return {
      check: 'mcp:handshake',
      status: 'fail',
      detail: `${command} mcp did not answer initialize: ${said || describeFailure(error).message}`,
      fix: 'Run kanbo mcp in the project yourself to see why it does not start.',
    }
  }
  finally {
    await client.close().catch(() => {})
  }
}

/**
 * The first registration that names something that can be started — with its
 * own arguments when it names its program by full path — else `kanbo mcp`
 * from `PATH`.
 */
function findStartable(registrations: Registration[], platform: NodeJS.Platform): { command: string, args: string[] } | null {
  for (const registration of registrations) {
    const { command, args } = registration
    // Starting it here goes through cross-spawn, which runs a .cmd; Codex would not, so it proves nothing.
    if (codexCannotStart(registration, platform)) {
      continue
    }
    if (command && isAbsolute(command)) {
      if (existsSync(command) && args.filter(arg => isAbsolute(arg)).every(arg => existsSync(arg))) {
        return { command, args }
      }
      continue
    }
    const found = command && findOnPath(command)
    if (found) {
      return { command: found, args: [...MCP_ARGS] }
    }
  }
  const found = findOnPath(MCP_COMMAND)
  return found ? { command: found, args: [...MCP_ARGS] } : null
}

/**
 * A Codex registration on Windows that names a `.cmd`/`.bat`, by path or by a
 * bare name that finds one — `kanbo`, which there is npm's `kanbo.cmd`. Codex
 * starts programs without a shell, and without one Windows cannot run either.
 * A bare name that finds no `.exe` is taken for the shim it would be.
 */
function codexCannotStart({ client, command }: Registration, platform: NodeJS.Platform): boolean {
  if (client !== 'codex' || platform !== 'win32' || !command) {
    return false
  }
  if (isWindowsAbsolute(command)) {
    return /\.(?:cmd|bat)$/i.test(command)
  }
  return !/\.(?:exe|com)$/i.test(findOnPath(command, { platform }) ?? '')
}

/** `C:\…`, `\\server\…` or a POSIX-style absolute path — what `isAbsolute` says on Windows, on any OS. */
function isWindowsAbsolute(command: string): boolean {
  return /^(?:[a-z]:[\\/]|[\\/])/i.test(command)
}

/** The command that registers kanbo with this client again, in the same scope. */
function connectCommand(client: AgentId, scope: Registration['scope']): string {
  return `kanbo connect ${client} ${scope === 'project' ? '--project' : '--global'}`
}

function checkActor(): DoctorFinding {
  const marker = readAgentShellMarker()
  if (marker !== null) {
    return {
      check: 'actor',
      status: 'warn',
      detail: `This shell says it belongs to an agent (${marker}): approve and return refuse here.`,
      fix: marker === 'KANBO_ACTOR_KIND=agent'
        ? 'If this is your own terminal, remove KANBO_ACTOR_KIND from your shell profile.'
        : 'If this is your own terminal, set KANBO_ACTOR_KIND=person in it.',
    }
  }
  return { check: 'actor', status: 'ok', detail: 'This shell is a person\'s.' }
}

/** The environment as the SDK wants it: every value a string, so `KANBO_*` reaches the server as it would from a client. */
function stringEnvironment(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
}

function realPath(path: string): string {
  try {
    return realpathSync(path)
  }
  catch {
    return path
  }
}

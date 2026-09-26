import type { Command } from 'commander'

import type { BoardStore } from '../board-store'
import type { BoardWorkspaceIdentity } from '../domain/numbering'
import { readIssuePrefix } from '../domain/numbering'
import type { BoardOps } from '../ops'
import { createBoardOps } from '../ops'
import { createPostgresBoardStore } from '../postgres/board-store.postgres'
import { createSqliteBoardStore } from '../sqlite/board-store.sqlite'
import { openBoardDatabase } from '../sqlite/open-database'
import type { Issue, IssueRun } from '../sqlite/schema'
import type { BoardTarget } from './db-target'
import { resolveDbTarget } from './db-target'
import type { CliOutputOptions, CliResult } from './output'
import { CliError, EXIT_NOT_RESOLVED, printResult, readFormat } from './output'
import { openPostgresBoard } from './postgres-board'
import { assertInstalledBoard, assertWritableBoard } from './schema-guard'
import { resolveWorkspace } from './workspace'

/**
 * What every board command needs before it can do its one thing: the board
 * file, the workspace, the operations bound to them — and, when it is over, the
 * way its result and its failures reach the caller.
 *
 * Commands are written against this rather than opening databases themselves,
 * so the rules that must hold for all of them hold in one place: a write never
 * touches a database older than this build, the connection is always closed,
 * and a failure always leaves with the exit code the tool promises for it.
 */

/** The options that say which board a command works on, and how it answers. */
export interface BoardTargetCommandOptions extends CliOutputOptions {
  db?: string
  databaseUrl?: string
  /**
   * Reach the board as an agent rather than as whoever owns this shell. Not a
   * flag anyone types — `kanbo mcp` sets it, because the client it serves is
   * the agent.
   */
  asAgent?: boolean
}

/** The same, plus the workspace — which every command but `migrate` and `roles` is about. */
export interface BoardCommandOptions extends BoardTargetCommandOptions {
  workspace?: string
}

/** One open board, and everything a command does its work through. */
export interface BoardSession {
  ops: BoardOps
  store: BoardStore
  /** The workspace the command is about, and the key its cards are numbered with. */
  workspace: BoardWorkspaceIdentity
  /**
   * Refuse a write to a board this build cannot speak for. A command declares
   * a write when it opens the session; a server that holds one open for many
   * calls asks again before each of them.
   */
  assertWritable: () => Promise<void>
}

/** The same, held by a caller that outlives one command and closes it itself. */
export interface OpenBoardSession extends BoardSession {
  close: () => Promise<void>
}

/** Whether the command is going to write to the board. Writes are guarded; reads are not. */
export type BoardCommandMode = 'read' | 'write'

/** The two modes a card can be worked in, as `issues.execution_mode` spells them. */
const EXECUTION_MODES = ['worktree', 'main'] as const

/** Add the options that name a board and shape the answer, wherever the command sits in the tree. */
export function withTargetOptions(command: Command): Command {
  return command
    .option('--db <path>', 'board database file to open')
    .option('--database-url <url>', 'external Postgres board to work on instead of a board file')
    .option('--json <fields>', 'print only these comma-separated fields, as JSON')
    .option('--format <format>', 'output format: json or pretty')
}

/** The same, plus the workspace: the options every command about cards carries. */
export function withBoardOptions(command: Command): Command {
  return withTargetOptions(command)
    .option('--workspace <nameOrId>', 'workspace the command is about')
}

/**
 * Open the board the caller named and resolve the workspace it is about.
 *
 * The board stays open until the caller closes it: one command does its one
 * thing and closes, while `kanbo mcp` holds the same session open for as long
 * as a client is talking to it. A failure on the way out closes the board first
 * — a caller that never received a session has nothing to close.
 */
export async function openBoardSession(
  options: BoardCommandOptions,
  mode: BoardCommandMode,
): Promise<OpenBoardSession> {
  const cwd = process.cwd()
  const target = resolveDbTarget({
    explicitPath: options.db,
    explicitUrl: options.databaseUrl,
    asAgent: options.asAgent,
    cwd,
  })
  return target.kind === 'postgres'
    ? await openExternalSession(target, options, cwd)
    : await openFileSession(target, options, mode, cwd)
}

async function openFileSession(
  target: Extract<BoardTarget, { kind: 'sqlite' }>,
  options: BoardCommandOptions,
  mode: BoardCommandMode,
  cwd: string,
): Promise<OpenBoardSession> {
  const board = await openBoardDatabase(target.path)
  try {
    const assertWritable = async (): Promise<void> => {
      assertWritableBoard(board.database, target.owner)
    }
    if (mode === 'write') {
      assertWritableBoard(board.database, target.owner)
    }
    // A file of this package's own holds no `workspaces` table to look up —
    // the same reason an external board resolves from the binding alone.
    const workspace = resolveWorkspace(
      target.owner === 'kanbo' ? { kind: 'file' } : { kind: 'sqlite', database: board.database },
      { explicit: options.workspace, cwd },
    )
    const store = createSqliteBoardStore({ database: () => board.database })
    return { ops: createBoardOps(store), store, workspace, assertWritable, close: async () => board.close() }
  }
  catch (error) {
    board.close()
    throw error
  }
}

/**
 * The same, on a board that is a database of its own.
 *
 * The guard runs whatever the command came to do. A board file that this build
 * cannot write to is still a board worth reading; a connection string pointing
 * at a database with no board in it is nothing to read at all, and every
 * command would otherwise fail one statement later with the driver's own words.
 */
async function openExternalSession(
  target: Extract<BoardTarget, { kind: 'postgres' }>,
  options: BoardCommandOptions,
  cwd: string,
): Promise<OpenBoardSession> {
  const board = await openPostgresBoard(target.url)
  try {
    const assertWritable = async (): Promise<void> => {
      await assertInstalledBoard(board.database)
    }
    await assertWritable()
    const workspace = resolveWorkspace({ kind: 'postgres' }, { explicit: options.workspace, cwd })
    const store = createPostgresBoardStore({ database: board.database })
    return { ops: createBoardOps(store), store, workspace, assertWritable, close: board.close }
  }
  catch (error) {
    await board.close()
    throw error
  }
}

/**
 * Open the board, do the one thing, print the result, close the board.
 *
 * The output options are checked before anything is opened: a caller who
 * mistyped `--format` should hear about it instead of writing to the board and
 * then failing to print what they wrote.
 */
export async function runBoardCommand(
  options: BoardCommandOptions,
  mode: BoardCommandMode,
  body: (session: BoardSession) => Promise<CliResult>,
): Promise<void> {
  readFormat(options)

  const session = await openBoardSession(options, mode)
  try {
    printResult(await body(session), options)
  }
  finally {
    await session.close()
  }
}

/** Where a card's work happens. A caller naming anything else is refused, not corrected. */
export function parseExecutionMode(value: string): Issue['executionMode'] {
  const mode = EXECUTION_MODES.find(candidate => candidate === value)
  if (!mode) {
    throw new CliError(1, `Unknown execution mode "${value}". Use ${EXECUTION_MODES.join(' or ')}.`)
  }
  return mode
}

/** A count a caller typed, refused rather than quietly rounded when it is not one. */
export function parseCount(value: string): number {
  const count = Number(value)
  if (!Number.isInteger(count) || count <= 0) {
    throw new CliError(1, `Expected a positive whole number, got "${value}".`)
  }
  return count
}

/**
 * The card a caller named, in the workspace the command is about.
 *
 * People and agents refer to a card by whatever they have in front of them: the
 * key printed on the board (`MAN-012`), the same key typed without the padding
 * (`MAN-12`), or just the number. All three mean one card in one workspace, and
 * a tool that only accepted the exact key would be wrong about that.
 *
 * Every lookup is scoped to the workspace, keys included. One database holds
 * every project's board, so an unscoped `findById` would let a key pasted from
 * another project — or from an agent that resolved the wrong workspace — move a
 * card on a board the caller is not even looking at.
 */
export async function requireCard(session: BoardSession, reference: string): Promise<Issue> {
  const trimmed = reference.trim()
  const byId = await session.store.issues.findInWorkspace(session.workspace.id, trimmed)
  if (byId) {
    return byId
  }

  const number = readCardNumber(session, trimmed)
  const byNumber = number === null ? null : await session.store.issues.findByNumber(session.workspace.id, number)
  if (!byNumber) {
    throw new CliError(EXIT_NOT_RESOLVED, `No card "${reference}" on this board.`)
  }
  return byNumber
}

/**
 * The run a caller named, in the workspace the command is about.
 *
 * A run id is opaque — there is no key to read a workspace off — so the card it
 * belongs to answers instead. One database holds every project's board, and a
 * run id pasted from another project would otherwise end a run on a board this
 * caller is not even looking at. The refusal is the one every other command
 * gives for something that is not on this board.
 */
export async function requireRun(session: BoardSession, runId: string): Promise<IssueRun> {
  const run = await session.store.runs.findById(runId.trim())
  const card = run ? await session.store.issues.findInWorkspace(session.workspace.id, run.issueId) : null
  if (!run || !card) {
    throw new CliError(EXIT_NOT_RESOLVED, `No run "${runId}" on this board.`)
  }
  return run
}

/**
 * The card number a reference names — but only when it is a reference to this
 * board's own cards.
 *
 * A bare number is one. A key is one only when its stem is this workspace's own
 * prefix: `MAN-12` and `MAN-012` are the same card, while `OTH-001` is another
 * board's key that happens to end in a number this board also uses, and reading
 * the digits off it would quietly hand back the wrong card.
 */
function readCardNumber(session: BoardSession, reference: string): number | null {
  if (/^\d+$/.test(reference)) {
    return Number(reference)
  }

  const separator = reference.lastIndexOf('-')
  const digits = reference.slice(separator + 1)
  if (separator < 0 || !/^\d+$/.test(digits)) {
    return null
  }
  const prefix = readIssuePrefix(session.workspace)
  return reference.slice(0, separator).toUpperCase() === prefix ? Number(digits) : null
}

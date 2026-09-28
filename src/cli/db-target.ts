import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { maskDatabaseUrl } from '../domain/database-url'
import type { BoardFileOwner } from '../sqlite/open-database'
import { readBoardFileContents } from '../sqlite/open-database'
import { describePersonOverride, isAgentShell } from './actor'
import { findBinding } from './binding'
import { CliError, EXIT_NOT_RESOLVED } from './output'

/**
 * Which board the command works on.
 *
 * A board is a SQLite file — one of a project's own (`kanbo init --file`), or
 * a host app's database the board lives inside — or a Postgres database of its
 * own, and the command line reaches all three. What the caller typed comes
 * first, and only one of `--db` and `--database-url` may be typed: together
 * they name two boards, which is a mistake to say out loud rather than a
 * precedence to resolve. Failing a flag, a connection string is looked for —
 * the environment, then the project's binding — because a project bound to a
 * database has no board file to fall back to, and a fallback that quietly wrote
 * to some local file instead is the one mistake worth making impossible.
 *
 * Failing a connection string, a board file is looked for: the project's own
 * binding first — `kanbo init --file` records the file it created — and only
 * then `KANBO_DB_PATH`, which is how an app that embeds the board tells the
 * shells it starts where its database is. Nothing here is created and nothing
 * is migrated — a file that is not there means the person has not run
 * `kanbo init --file` yet, and saying so is more useful than opening an empty
 * database they will never see. Whichever file is chosen, `readFileOwnerAt`
 * says whose file it is: the marker `kanbo init --file` leaves is what every
 * later command reads to decide whether it may look up a `workspaces` row in
 * it at all (ruling 5-4).
 */

export const DATABASE_NOT_FOUND_MESSAGE
  = 'This folder has no kanbo board yet. Run kanbo to set one up (or kanbo init --yes for the defaults).'

/**
 * The same, in an agent's shell: setting a board up is a person's call. Every
 * agent-facing "no board" says exactly this; in a shell (not the MCP server) a
 * second line tells a person in an editor terminal how to run kanbo anyway.
 */
export const DATABASE_NOT_FOUND_AGENT_MESSAGE = 'This folder has no kanbo board yet. Ask a person to run kanbo here.'

/**
 * Nothing names a board here — not a board that failed to open. Its own class
 * so a caller that has something better to do than fail (the MCP server, bare
 * `kanbo`) asks by type rather than by the words of the message.
 */
export class BoardNotFoundError extends CliError {
  constructor(message = isAgentShell() ? `${DATABASE_NOT_FOUND_AGENT_MESSAGE}\n${describePersonOverride('kanbo')}` : DATABASE_NOT_FOUND_MESSAGE) {
    super(EXIT_NOT_RESOLVED, message)
    this.name = 'BoardNotFoundError'
  }
}

/** What a person is told when the board file this project is bound to (or `KANBO_DB_PATH` names) is not there. */
export function describeMissingBoardFile(path: string): string {
  return `This project's board file is missing: ${path}. Create a new empty board here: kanbo init --file `
    + '(the old cards are gone), or restore the file.'
}

/**
 * The board file the binding or `KANBO_DB_PATH` names is gone — not a folder
 * that never had a board. Still "no board here" to a caller that only needs to
 * know that (the MCP server); bare `kanbo` and `kanbo init` tell the two apart,
 * because "run kanbo to set one up" is the wrong advice for a board that was
 * set up and then lost.
 */
export class BoardFileMissingError extends BoardNotFoundError {
  constructor(readonly path: string) {
    super(describeMissingBoardFile(path))
    this.name = 'BoardFileMissingError'
  }
}

/**
 * The board file this folder would open with no flag — the one it is bound to,
 * or else the one `KANBO_DB_PATH` names — when that file is not there; `null`
 * when it is there, or when a connection string names the board first.
 */
export function findMissingBoardFile(cwd: string): string | null {
  if (resolveDatabaseUrl({ cwd, asAgent: false })) {
    return null
  }
  const path = readBoundDbPath({ cwd }) || readEnvironmentDbPath()
  return path && !existsSync(path) ? path : null
}

/** What a caller is told when they name both kinds of board at once. */
export const TWO_BOARDS_MESSAGE
  = 'One board at a time: pass --db for a board file or --database-url for a shared Postgres board, not both.'

/** Where the board this command works on lives. */
export type BoardTarget
  = | { kind: 'sqlite', path: string, owner: BoardFileOwner }
    | { kind: 'postgres', url: string }

/** What a caller typed, and where they typed it. */
export interface BoardTargetInput {
  /** What `--db` was given: a board file. */
  explicitPath?: string | null
  /** What `--database-url` was given: an external board's connection string. */
  explicitUrl?: string | null
  /** The directory the command was typed in; the binding is looked for at or above it. */
  cwd?: string
  /**
   * Reach the board as an agent rather than as whoever owns this shell. Never
   * typed: `kanbo mcp` sets it, because the client it serves is the agent, and
   * every other command asks the shell itself.
   */
  asAgent?: boolean
}

/**
 * The board to open, in the order a caller would expect to be obeyed: what
 * they typed, what they exported for this tool, what the project folder was
 * bound to, and only then the board file the environment names.
 *
 * A typed flag beats the environment, whichever kind of board it names: a
 * person who passes `--db` is looking at that file, and an exported connection
 * string left over from another project is not a reason to open something else.
 */
export function resolveDbTarget(input: BoardTargetInput = {}): BoardTarget {
  const explicitPath = input.explicitPath?.trim()
  const explicitUrl = input.explicitUrl?.trim()
  if (explicitPath && explicitUrl) {
    throw new CliError(1, TWO_BOARDS_MESSAGE)
  }
  if (explicitUrl) {
    return { kind: 'postgres', url: explicitUrl }
  }
  if (explicitPath) {
    return toSqliteTarget(resolveDbPath({ explicitPath }))
  }

  const url = resolveDatabaseUrl(input)
  return url ? { kind: 'postgres', url } : toSqliteTarget(resolveDbPath(input))
}

/** The sqlite half of a target: the path, and who wrote the file it names. */
function toSqliteTarget(path: string): BoardTarget {
  return { kind: 'sqlite', path, owner: readFileOwnerAt(path) }
}

/**
 * Who wrote this file's board, without leaving a second connection open onto
 * it: opened, read, closed, before the caller opens the file for real.
 *
 * A file with no board in it yet still reads as a host database's — `assertBoardSchema`
 * is what says a board is missing or too old, once the caller actually tries to
 * use it. A path that is not a SQLite database at all is a different mistake
 * and gets its own answer: `kanbo card list --db ./README.md` used to leave
 * the driver's own sentence and its stack, where every other way of naming the
 * wrong board leaves one line and exit `2`.
 */
function readFileOwnerAt(path: string): BoardFileOwner {
  try {
    return readBoardFileContents(path).owner
  }
  catch {
    throw new CliError(EXIT_NOT_RESOLVED, `${path} is not a board file kanbo can open.`)
  }
}

/**
 * The external board named for this command, or `null` when none is.
 *
 * Apart from `resolveDbTarget` itself, this is for the two commands that do
 * not take a board the ordinary way: `kanbo init`, where `--db` names the
 * host database rather than the board being bound, and the administrative ones,
 * which never take the agent's login.
 */
export function resolveDatabaseUrl(input: BoardTargetInput = {}): string | null {
  return input.explicitUrl?.trim() || process.env.KANBO_DATABASE_URL?.trim() || readBoundDatabaseUrl(input)
}

/**
 * The external board this project is bound to, as this shell should reach it.
 *
 * A binding may carry two connection strings: the one a person uses, and the
 * one the agent role logs in with. An agent's shell — and the MCP server, whose
 * whole client is an agent — is given the second when it is there, so the rules
 * the database keeps about `kanban_agent` are the rules it actually meets.
 * Nothing about this is a secret from the agent: it is a different login, not a
 * hidden one, and a project with only one string hands that one to everybody.
 */
function readBoundDatabaseUrl(input: BoardTargetInput): string | null {
  const bound = findBinding(input.cwd ?? process.cwd())?.binding
  if (!bound) {
    return null
  }
  const asAgent = input.asAgent ?? isAgentShell()
  return (asAgent ? bound.agentDatabaseUrl?.trim() : null) || bound.databaseUrl?.trim() || null
}

/**
 * The board file to open, in the order a caller would expect to be obeyed:
 * what they typed, the file this project was bound to by `kanbo init --file`,
 * and what they exported for this tool.
 *
 * The chosen path has to exist. A `--db` that is not there is a typo, not an
 * invitation to fall back to the real board and write to it by mistake.
 */
function resolveDbPath(input: BoardTargetInput = {}): string {
  const explicitPath = input.explicitPath?.trim()
  if (explicitPath) {
    return requireExisting(explicitPath)
  }
  const path = readBoundDbPath(input) || readEnvironmentDbPath()
  if (path && !existsSync(path)) {
    throw new BoardFileMissingError(path)
  }
  return requireExisting(path)
}

/**
 * A host app's database on this machine, never through this project's own
 * `kanbo init --file` binding: what `--db` was given, or `KANBO_DB_PATH`.
 *
 * `kanbo init` calls this — not `resolveDbPath` — to find the database it
 * reads a workspace's id and card-key off before binding this project to a
 * database or a board file of its own. Whether *this* project already has a
 * board file of its own is not that question: a project bound to one by an
 * earlier `kanbo init --file` still has cards to read a workspace off if a
 * host database also knows this folder, and that file has no `workspaces`
 * table to be misread as one either way.
 */
export function resolveHostDbPath(explicitPath?: string | null): string {
  return requireExisting(explicitPath?.trim() || readEnvironmentDbPath())
}

function requireExisting(path: string | null): string {
  if (!path || !existsSync(path)) {
    throw new BoardNotFoundError()
  }
  return path
}

/**
 * The board file this project was bound to by `kanbo init --file`, resolved
 * against the project root the binding was found in — `dbPath` is written
 * relative to it, the same way a project's own `node_modules/.bin` is relative
 * to the project rather than to whichever subdirectory a shell happens to be
 * standing in.
 */
function readBoundDbPath(input: BoardTargetInput): string | null {
  const found = findBinding(input.cwd ?? process.cwd())
  if (!found) {
    return null
  }
  const dbPath = found.binding.dbPath?.trim()
  return dbPath ? resolve(found.projectDir, dbPath) : null
}

/** The board file the environment names — the one an app that embeds the board exports for the shells it starts. */
function readEnvironmentDbPath(): string | null {
  return process.env.KANBO_DB_PATH?.trim() || null
}

/** The board a command worked on, in the one line a person reads or a result carries. */
export function describeTarget(target: BoardTarget): string {
  return target.kind === 'postgres' ? maskDatabaseUrl(target.url) : target.path
}

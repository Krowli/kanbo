import { realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'

import { sql } from 'drizzle-orm'
import { z } from 'zod'

import type { BoardWorkspaceIdentity } from '../domain/numbering'
import type { SqliteDatabase } from '../sqlite/transaction'
import { findBinding } from './binding'
import { CliError, EXIT_NOT_RESOLVED } from './output'

/**
 * Which workspace the command is about.
 *
 * Cards are numbered per workspace and columns belong to one, so a command
 * typed in a project folder has to arrive at a workspace — its id, and the
 * identifier its card keys are built from — somehow. Where the answer comes
 * from is the one thing the two kinds of board do not share.
 *
 * In a host database — an app's own SQLite file the board lives inside — this
 * is the one place the tool reads a table it does not own: the record of which
 * folder is which workspace is the app's `workspaces` row (`id`, `name`,
 * `identifier`, `locator_json`). The module reads that row and nothing else —
 * the name, the identifier the issue key is built from, and the path inside the
 * locator — and never writes there. It reads it as four columns of raw SQL
 * rather than through a schema, because this package declares the board and
 * not the app: a table belonging to somebody else is read by name, or the library would carry
 * a copy of a schema it does not own (ruling 5-1).
 *
 * An external board, like a board file of a project's own, holds only the
 * board. There is no `workspaces` table to
 * read, so nothing can be looked up and everything has to have been said:
 * `--workspace`, the environment, or the binding `kanbo init` wrote.
 */

/**
 * The part of a workspace locator this tool understands: which machine the
 * project is on, and where it is there. The app that writes the row owns the
 * full shape; a row that does not carry these two is not a locator this tool
 * can act on, and is skipped.
 */
const LocatorSchema = z.object({
  nodeId: z.string().trim().min(1),
  path: z.string().trim().min(1),
})

/** The node id a locator gives this machine. */
const LOCAL_NODE_ID = 'local'

/**
 * The one message that has to work for `kanbo init` too. A command that told a
 * person to run `init` while they were running `init` would be answering a
 * question they did not ask, so what to do comes first and the binding second.
 */
const WORKSPACE_NOT_RESOLVED_MESSAGE
  = 'Could not tell which workspace this is. Pass --workspace <name|id>, '
    + 'or run "kanbo init" in the project folder.'

/** The same, for a board that cannot look a workspace up at all. */
export const EXTERNAL_WORKSPACE_NOT_RESOLVED_MESSAGE
  = 'Could not tell which workspace this is. An external board holds no workspaces table, so pass '
    + '--workspace <id>, set KANBO_WORKSPACE_ID, or run "kanbo init --database-url <url>" in the project folder.'

/** And the one that is missing only the key a card is numbered with. */
export const EXTERNAL_IDENTIFIER_NOT_RESOLVED_MESSAGE
  = 'Could not tell what this workspace\'s card keys start with. An external board holds no workspaces table, '
    + 'so the key comes from this project\'s binding: run '
    + '"kanbo init --database-url <url> --workspace <id> --identifier <KEY>" in the project folder.'

/** The same two, for a board file of this project's own — which holds no `workspaces` table either. */
export const FILE_WORKSPACE_NOT_RESOLVED_MESSAGE
  = 'Could not tell which workspace this is. A board file of this project\'s own holds no workspaces table, so '
    + 'pass --workspace <id>, set KANBO_WORKSPACE_ID, or run "kanbo init --file" in the project folder.'

export const FILE_IDENTIFIER_NOT_RESOLVED_MESSAGE
  = 'Could not tell what this workspace\'s card keys start with. A board file of this project\'s own holds no '
    + 'workspaces table, so the key comes from this project\'s binding: run "kanbo init --file --workspace <id> '
    + '--identifier <KEY>" in the project folder.'

/**
 * A host database's workspace, as much of one as this tool reads: the four
 * columns the statement below selects. The app's own row may have more, and
 * none of it is this package's business.
 */
interface HostWorkspaceRow {
  id: string
  name: string
  identifier: string
  locatorJson: string
}

/** Where a command's workspace is looked up — or the fact that it cannot be. */
export type BoardWorkspaceSource
  = | { kind: 'sqlite', database: SqliteDatabase }
    | { kind: 'postgres' }
    | { kind: 'file' }

/** How a command names the workspace it means, and where it was typed. */
export interface WorkspaceResolutionInput {
  /** What `--workspace` was given: a workspace name or its id — an id only, on an external board. */
  explicit?: string | null
  /** The directory the command was typed in. */
  cwd: string
}

/**
 * The workspace to work on, and everything card numbering needs to know about
 * it. The board never reads anybody else's tables to build an issue key, so the
 * identity is resolved here, once, and handed over.
 */
export function resolveWorkspace(
  source: BoardWorkspaceSource,
  input: WorkspaceResolutionInput,
): BoardWorkspaceIdentity {
  if (source.kind === 'sqlite') {
    return toIdentity(findLocalWorkspace(source.database, input))
  }
  return resolveBindingOnlyWorkspace(input, source.kind === 'file' ? FILE_MESSAGES : EXTERNAL_MESSAGES)
}

/**
 * The workspace row to work on, in the order a caller would expect to be
 * obeyed: what they typed, what they exported, what the project folder was
 * bound to, and finally the workspace whose own path contains the folder they
 * are standing in.
 *
 * Every path ends at a row that exists. A binding pointing at a workspace
 * someone deleted is a broken binding, and saying so beats numbering a card
 * into a workspace that is not there.
 */
function findLocalWorkspace(database: SqliteDatabase, input: WorkspaceResolutionInput): HostWorkspaceRow {
  const rows = listWorkspaces(database)

  const explicit = input.explicit?.trim()
  if (explicit) {
    return findByNameOrId(rows, explicit)
  }

  const fromEnvironment = process.env.KANBO_WORKSPACE_ID?.trim()
  if (fromEnvironment) {
    return findByNameOrId(rows, fromEnvironment)
  }

  const bound = findBinding(input.cwd)
  if (bound) {
    return findByNameOrId(rows, bound.binding.workspaceId)
  }

  const enclosing = findEnclosingWorkspace(rows, input.cwd)
  if (enclosing) {
    return enclosing
  }

  throw new CliError(EXIT_NOT_RESOLVED, WORKSPACE_NOT_RESOLVED_MESSAGE)
}

/** The two messages a board with no `workspaces` table refuses with — one pair per kind of such a board. */
interface BindingOnlyMessages {
  workspace: string
  identifier: string
}

const EXTERNAL_MESSAGES: BindingOnlyMessages = {
  workspace: EXTERNAL_WORKSPACE_NOT_RESOLVED_MESSAGE,
  identifier: EXTERNAL_IDENTIFIER_NOT_RESOLVED_MESSAGE,
}

const FILE_MESSAGES: BindingOnlyMessages = {
  workspace: FILE_WORKSPACE_NOT_RESOLVED_MESSAGE,
  identifier: FILE_IDENTIFIER_NOT_RESOLVED_MESSAGE,
}

/**
 * The same question asked of a board that cannot answer it — an external
 * database or a board file of the project's own, which is the one difference
 * between the two that matters here: neither holds a `workspaces` table.
 *
 * Nothing is looked up: an id is what the caller said, and the key its cards
 * are numbered with is what `kanbo init` wrote into the binding. The binding's
 * key is only trusted for the workspace the binding is about — a `--workspace`
 * naming another one would otherwise number its cards with this project's
 * prefix, and two workspaces would print the same key.
 */
function resolveBindingOnlyWorkspace(input: WorkspaceResolutionInput, messages: BindingOnlyMessages): BoardWorkspaceIdentity {
  const bound = findBinding(input.cwd)?.binding
  const id = input.explicit?.trim() || process.env.KANBO_WORKSPACE_ID?.trim() || bound?.workspaceId
  if (!id) {
    throw new CliError(EXIT_NOT_RESOLVED, messages.workspace)
  }

  const identifier = bound?.workspaceId === id ? bound?.identifier?.trim() : null
  if (!identifier) {
    throw new CliError(EXIT_NOT_RESOLVED, messages.identifier)
  }
  // Neither board has a name for a workspace either, and the key is the one
  // thing a person recognises it by.
  return { id, identifier, name: identifier }
}

function toIdentity(workspace: HostWorkspaceRow): BoardWorkspaceIdentity {
  return { id: workspace.id, identifier: workspace.identifier, name: workspace.name }
}

function listWorkspaces(database: SqliteDatabase): HostWorkspaceRow[] {
  return database
    .all<{ id: string, name: string, identifier: string, locator_json: string }>(
      sql`select id, name, identifier, locator_json from workspaces`,
    )
    .map(row => ({ id: row.id, name: row.name, identifier: row.identifier, locatorJson: row.locator_json }))
}

/**
 * The workspace a caller named, by id first and by name second.
 *
 * Names are not unique — two checkouts of the same repository are two
 * workspaces with one name — so a name that matches more than one is refused
 * rather than resolved to whichever row came back first. Guessing here would
 * put a card on the wrong board and say nothing.
 */
function findByNameOrId(rows: HostWorkspaceRow[], nameOrId: string): HostWorkspaceRow {
  const byId = rows.find(row => row.id === nameOrId)
  if (byId) {
    return byId
  }

  const byName = rows.filter(row => row.name.toLowerCase() === nameOrId.toLowerCase())
  if (byName.length > 1) {
    throw new CliError(EXIT_NOT_RESOLVED, `More than one workspace is called "${nameOrId}": `
      + `${byName.map(row => row.id).join(', ')}. Name the one you mean by its id.`)
  }
  if (byName.length === 0) {
    throw new CliError(EXIT_NOT_RESOLVED, `No workspace in this database matches "${nameOrId}".`)
  }
  return byName[0]
}

/**
 * The workspace whose folder contains `cwd`. The deepest match wins: a worktree
 * registered inside a project is a workspace of its own, and standing in it
 * means working on it.
 *
 * Only workspaces on this machine are considered. A locator names a node as
 * well as a path, and a path on another machine that happens to read like this
 * one is a different folder entirely, so node ids are compared before paths. Both sides are compared as real paths, so a
 * project reached through a symlink still matches the workspace it is.
 */
function findEnclosingWorkspace(rows: HostWorkspaceRow[], cwd: string): HostWorkspaceRow | null {
  const directory = canonicalPath(cwd)
  const candidates = rows
    .flatMap((row) => {
      const locator = readLocator(row)
      if (!locator || locator.nodeId !== LOCAL_NODE_ID) {
        return []
      }
      const path = canonicalPath(locator.path)
      return directory === path || directory.startsWith(path + sep) ? [{ row, path }] : []
    })
    .sort((left, right) => right.path.length - left.path.length)

  return candidates[0]?.row ?? null
}

function readLocator(row: HostWorkspaceRow): z.infer<typeof LocatorSchema> | null {
  try {
    return LocatorSchema.parse(JSON.parse(row.locatorJson))
  }
  catch {
    return null
  }
}

/** The path itself, with symlinks resolved — or the absolute path, when it is not there to resolve. */
function canonicalPath(path: string): string {
  const absolute = resolve(path)
  try {
    return realpathSync(absolute)
  }
  catch {
    return absolute
  }
}

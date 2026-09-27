import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { z } from 'zod'

import { renameWithRetry } from './setup/fs-retry'

/**
 * What ties a project folder to a board.
 *
 * A person running `kanbo` in their project should not have to say which
 * workspace they mean, and the answer cannot live in any database: the folder
 * knows which project it is, a database does not know which folder the shell
 * is in. `kanbo init` writes the answer next to the code, in a directory kanbo
 * owns — never in the user's own `.gitignore`, which is theirs.
 */

/** The directory kanbo keeps inside a project: the binding, and a board file of the project's own. */
const PROJECT_DIRECTORY = '.kanbo'

/** The binding's own file name, which is also the line that keeps it out of git. */
const BINDING_FILE_NAME = 'binding.json'

/** The binding file itself, relative to the project root. */
export const BINDING_FILE_PATH = join(PROJECT_DIRECTORY, BINDING_FILE_NAME)

/** SQLite's two companions of a board file in WAL mode, which hold committed data of their own. */
const SQLITE_SIDE_FILES = ['-wal', '-shm'] as const

/** Readable and writable by its owner and by nobody else: it holds connection strings. */
const BINDING_FILE_MODE = 0o600

/**
 * The spellings of a `.gitignore` line that already cover the binding.
 *
 * Git's pattern language is not reimplemented here: the cost of failing to
 * recognise an exotic pattern is one redundant line in a file, and the cost of
 * guessing that some pattern covers the binding when it does not is a
 * workspace id committed to someone else's checkout.
 */
const BINDING_IGNORED_BY = new Set([BINDING_FILE_NAME, `/${BINDING_FILE_NAME}`, `./${BINDING_FILE_NAME}`, `**/${BINDING_FILE_NAME}`])

const BindingSchema = z.object({
  schemaVersion: z.literal(1),
  workspaceId: z.string().trim().min(1),
  boardId: z.string().trim().min(1).nullish(),
  /**
   * The board file `kanbo init --file` created for this project, relative to
   * the project root — `.kanbo/board.db` by default. Resolution honours it
   * between the connection-string checks and the `KANBO_DB_PATH` fallback: a
   * project bound to a file of its own falls back to *that* file rather than
   * a host database that may not exist on this machine. `null` on a project
   * that has never run `kanbo init --file`.
   */
  dbPath: z.string().nullish(),
  /**
   * The external board this project works on, when it has one. Unlike
   * `dbPath` this *is* read: a project bound to a database has no board file
   * to fall back to. It is a secret, and the binding is the one file here that
   * git never sees — which is why it may be written down at all.
   */
  databaseUrl: z.string().trim().min(1).nullish(),
  /**
   * The same board, as the agent role logs into it.
   *
   * A shell started for an agent — and the MCP server, whose whole
   * client is an agent — is given this one when it is there, so the rules the
   * database keeps about `kanban_agent` are the rules it actually meets. It is
   * a different login, not a hidden one; a project with only `databaseUrl`
   * hands that one to everybody.
   */
  agentDatabaseUrl: z.string().trim().min(1).nullish(),
  /**
   * What this workspace's card keys start with (`MAN` in `MAN-012`).
   *
   * An external board holds only the board: there is no `workspaces` row to
   * read a key off, so `kanbo init` writes the answer down here. On a board
   * file the row is still the truth and this is not read.
   */
  identifier: z.string().trim().min(1).nullish(),
})

/** The project's binding, as it is written and read back. */
export type KanboBinding = z.infer<typeof BindingSchema>

/** A binding that was found, the file it was found in, and the project it belongs to. */
export interface FoundBinding {
  path: string
  /** The project root the binding is for — where `.kanbo` sits, and what a relative `dbPath` is relative to. */
  projectDir: string
  binding: KanboBinding
}

/**
 * The nearest binding at or above `startDir`.
 *
 * Walking up is what makes the tool usable from a subdirectory: an agent that
 * `cd`s into `packages/web` is still working on the same project. A file that
 * does not parse is not a binding — the walk continues past it, and the caller
 * ends up with the same error as a project that was never bound.
 */
export function findBinding(startDir: string): FoundBinding | null {
  let directory = resolve(startDir)

  while (true) {
    const path = join(directory, BINDING_FILE_PATH)
    const binding = readBinding(path)
    if (binding) {
      return { path, projectDir: directory, binding }
    }
    const parent = dirname(directory)
    if (parent === directory) {
      return null
    }
    directory = parent
  }
}

/**
 * The binding this project folder has of its own — not a parent's.
 *
 * `kanbo init` merges into it rather than replacing it: a person re-running
 * the command to refresh an instruction block never said anything about the
 * board, and a second `init` that quietly dropped the connection string would
 * leave a project bound to nothing.
 */
export function readProjectBinding(projectDir: string): KanboBinding | null {
  return readBinding(join(projectDir, BINDING_FILE_PATH))
}

/** The binding in that exact file, or `null` when there is none to read. */
export function readBinding(path: string): KanboBinding | null {
  if (!existsSync(path)) {
    return null
  }
  try {
    return BindingSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
  }
  catch {
    return null
  }
}

/**
 * Bind the project folder to a board.
 *
 * The binding itself is kept out of git, because the workspace id in it means
 * nothing in anyone else's checkout. The ignore rule names the files kanbo
 * writes rather than `*`, so a person who does want something in `.kanbo`
 * committed can still add it. The user's own `.gitignore` is not touched at
 * all; it is not kanbo's file to edit.
 *
 * It is written `0600`, because it may hold one or two connection strings and
 * keeping a file out of a repository is not keeping it away from the other
 * accounts on the machine. `mode` only applies to a file this call creates, so
 * an existing one — a second `init`, or a file written before this rule — is
 * narrowed explicitly. Windows has no such bits and `chmodSync` does nothing
 * there, which is the right nothing: no permission to narrow, and no failure
 * to handle.
 */
export function writeBinding(projectDir: string, binding: KanboBinding): string {
  const directory = join(projectDir, PROJECT_DIRECTORY)
  mkdirSync(directory, { recursive: true })
  ignoreBindingFile(directory)

  // Written beside itself and renamed into place, so a crash half-way leaves
  // the old binding or the new one and never half of either.
  const path = join(projectDir, BINDING_FILE_PATH)
  const temporaryPath = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(BindingSchema.parse(binding), null, 2)}\n`, { mode: BINDING_FILE_MODE })
    chmodSync(temporaryPath, BINDING_FILE_MODE)
    renameWithRetry(temporaryPath, path)
  }
  catch (error) {
    rmSync(temporaryPath, { force: true })
    throw error
  }
  return path
}

/**
 * Make sure `.kanbo/.gitignore` covers the binding, and change nothing else
 * about it. Lines that are already there belong to whoever wrote them — this
 * appends one line, or none at all.
 */
function ignoreBindingFile(directory: string): void {
  const path = join(directory, '.gitignore')
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : null
  if (existing !== null && existing.split('\n').some(line => BINDING_IGNORED_BY.has(line.trim()))) {
    return
  }

  const kept = existing?.replace(/\s*$/, '') ?? ''
  writeFileSync(path, kept ? `${kept}\n${BINDING_FILE_NAME}\n` : `${BINDING_FILE_NAME}\n`)
}

/**
 * Make sure `.kanbo/.gitignore` also covers a board file of this project's
 * own — `kanbo init --file` calls this once, right after creating it — and
 * the two files SQLite leaves beside it in WAL mode, `-wal` and `-shm`, which
 * hold committed data of their own and are exactly as much a secret as the
 * database itself.
 *
 * Only when the file is inside `.kanbo`, which is where `--file` puts it by
 * default: the ignore rule only ever grows kanbo's own directory, and a path
 * chosen elsewhere in the project gets no line here, the same way the user's
 * own `.gitignore` is never touched at all.
 */
export function ignoreBoardFile(projectDir: string, absoluteDbPath: string): void {
  const directory = join(projectDir, PROJECT_DIRECTORY)
  const relativeToDirectory = relative(directory, absoluteDbPath)
  if (relativeToDirectory.startsWith('..') || isAbsolute(relativeToDirectory)) {
    return
  }

  mkdirSync(directory, { recursive: true })
  const wanted = [relativeToDirectory, ...SQLITE_SIDE_FILES.map(suffix => `${relativeToDirectory}${suffix}`)]
  const path = join(directory, '.gitignore')
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : null
  const already = new Set((existing ?? '').split('\n').map(line => line.trim()))
  const missing = wanted.filter(line => !already.has(line))
  if (missing.length === 0) {
    return
  }

  const kept = existing?.replace(/\s*$/, '') ?? ''
  writeFileSync(path, kept ? `${kept}\n${missing.join('\n')}\n` : `${missing.join('\n')}\n`)
}

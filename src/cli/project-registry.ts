import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { z } from 'zod'

import { BINDING_FILE_PATH } from './binding'
import { renameWithRetry } from './setup/fs-retry'

/**
 * Which project folders kanbo has opened a board in.
 *
 * Every project keeps its board in its own folder, so nothing else knows which
 * other projects exist. This list, in the user's home, is what lets one board
 * page offer them all. It holds a folder and a time — never a connection
 * string, never board data — and deleting it is safe: it fills again as the
 * projects are used.
 */

/** The file's name inside kanbo's per-user folder. */
const REGISTRY_FILE_NAME = 'projects.json'

/** The file is private to the user, as a binding is. */
const REGISTRY_FILE_MODE = 0o600

/** The folder holding it is private to the user too. */
const REGISTRY_DIRECTORY_MODE = 0o700

/**
 * A project noted within this many seconds is not noted again, so an ordinary
 * command does not rewrite the file: a day is fresh enough for "recently used".
 */
const RECENTLY_NOTED_SECONDS = 24 * 60 * 60

const RegisteredProjectSchema = z.object({
  path: z.string().min(1),
  lastSeenAt: z.number().int().nonnegative(),
})

const RegistrySchema = z.object({
  schemaVersion: z.literal(1),
  projects: z.array(RegisteredProjectSchema),
})

/** One project folder kanbo has opened a board in. */
export interface RegisteredProject {
  /** Absolute, canonical (realpath) project folder — where `.kanbo/` sits. */
  path: string
  /** Unix seconds, the last time a kanbo command opened this project's board. */
  lastSeenAt: number
}

/** `$KANBO_HOME/projects.json`, else `~/.kanbo/projects.json`. */
export function projectRegistryPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.KANBO_HOME?.trim()
  return join(home || join(homedir(), '.kanbo'), REGISTRY_FILE_NAME)
}

/** The projects, most recently seen first; `[]` when the file is missing or does not parse. */
export function readProjectRegistry(path: string = projectRegistryPath()): RegisteredProject[] {
  return readEntries(path).sort((a, b) => b.lastSeenAt - a.lastSeenAt)
}

/**
 * Note that `projectDir` was just used. Writes only when the folder is new or
 * was last noted more than a day ago, so ordinary commands do not rewrite the file.
 * Drops entries whose `.kanbo/binding.json` is gone.
 */
export function rememberProject(projectDir: string, options: { now?: number, path?: string } = {}): void {
  const now = options.now ?? Math.floor(Date.now() / 1000)
  const path = options.path ?? projectRegistryPath()
  const canonical = canonicalPath(projectDir)

  const entries = readEntries(path)
  const known = entries.find(entry => entry.path === canonical)
  if (known && now - known.lastSeenAt <= RECENTLY_NOTED_SECONDS) {
    return
  }

  const kept = entries.filter(entry => entry.path !== canonical && existsSync(join(entry.path, BINDING_FILE_PATH)))
  kept.push({ path: canonical, lastSeenAt: now })
  writeEntries(path, kept)
}

/**
 * `rememberProject`, for the places that must not fail because of it: a home
 * directory that cannot be written is not a reason for `kanbo card list` to fail.
 * With `KANBO_DEBUG=1` the reason is printed on stderr.
 */
export function rememberProjectQuietly(projectDir: string): void {
  const path = projectRegistryPath()
  try {
    rememberProject(projectDir, { path })
  }
  catch (error) {
    // The list is a convenience for the board page; the command that noted the
    // project has already done what the person asked and must not fail for it.
    if (process.env.KANBO_DEBUG === '1') {
      console.error(`kanbo: could not note this project in ${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

function canonicalPath(projectDir: string): string {
  const absolute = resolve(projectDir)
  try {
    return realpathSync(absolute)
  }
  catch {
    return absolute
  }
}

function readEntries(path: string): RegisteredProject[] {
  try {
    const parsed = RegistrySchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    return parsed.success ? parsed.data.projects : []
  }
  catch {
    return []
  }
}

function writeEntries(path: string, projects: RegisteredProject[]): void {
  mkdirSync(dirname(path), { recursive: true, mode: REGISTRY_DIRECTORY_MODE })
  const temporaryPath = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(RegistrySchema.parse({ schemaVersion: 1, projects }), null, 2)}\n`, { mode: REGISTRY_FILE_MODE })
    chmodSync(temporaryPath, REGISTRY_FILE_MODE)
    renameWithRetry(temporaryPath, path)
  }
  catch (error) {
    rmSync(temporaryPath, { force: true })
    throw error
  }
}

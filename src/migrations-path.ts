import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Where this build keeps a board's migrations, whichever dialect is asking.
 *
 * The folder is found relative to the file asking for it, because the same code
 * runs from two layouts: from `src/<dialect>/` in a checkout, where the folder
 * sits at the package root, and from `dist/cli.cjs` in an installed build, where
 * the build has copied it in beside the bundle. The npm tarball and the packaged
 * command alike ship only that copy — `dist/` is the whole of it — so it is the
 * only migrations folder an installed kanbo has.
 *
 * Kept apart from the migrators on purpose: this is a packaging question, and
 * two dialects ask it about two folders. The caller passes its own `here`, so
 * the depth is the caller's rather than this file's.
 */

/** What makes a candidate folder the migrations folder rather than an empty directory. */
const JOURNAL_FILE = join('meta', '_journal.json')

/**
 * The first of the layouts that is actually there, as seen from `here`.
 *
 * Pure, and takes its own `exists`, so every layout can be asked about on
 * a machine that only has one of them. When none is there the source layout is
 * handed back, so the migrator's complaint names the folder a developer is
 * missing rather than one that only exists inside a packaged app.
 */
export function resolveBoardMigrationsPath(
  here: string,
  directory: string,
  exists: (folder: string) => boolean,
): string {
  const candidates = [
    // src/<dialect>/ → the package root, in a checkout.
    join(here, '..', '..', directory),
    // dist/ → beside the bundle, in an installed build.
    join(here, directory),
    // dist/lib/ → dist/, from a shared chunk of the library build: the copy
    // beside the command's bundle is the only one the tarball ships (the
    // package root's folders stay in the checkout). An entry one directory
    // deeper, `dist/lib/<dialect>/`, reaches the same copy through the first
    // candidate.
    join(here, '..', directory),
  ]
  return candidates.find(exists) ?? candidates[0]
}

/** Whether a candidate folder holds a drizzle journal — the real `exists` the two callers pass. */
export function hasMigrationJournal(folder: string): boolean {
  return existsSync(join(folder, JOURNAL_FILE))
}

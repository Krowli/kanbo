import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { hasMigrationJournal, resolveBoardMigrationsPath } from '../migrations-path'

/** The folder's name, wherever it has been put. */
const MIGRATIONS_DIRECTORY = 'drizzle-postgres'

/**
 * The board's Postgres migrations for the file that is running right now — the
 * ones `kanbo migrate` applies to an external database. The two
 * layouts this has to survive are `src/migrations-path.ts`'s subject.
 */
export function getBoardMigrationsPath(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return resolveBoardMigrationsPath(here, MIGRATIONS_DIRECTORY, hasMigrationJournal)
}

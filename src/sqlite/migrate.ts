import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { migrate } from 'drizzle-orm/better-sqlite3/migrator'

import { hasMigrationJournal, resolveBoardMigrationsPath } from '../migrations-path'
import type { SqliteDatabase } from './transaction'

/** The folder's name, wherever it has been put. */
const MIGRATIONS_DIRECTORY = 'drizzle-sqlite'

/**
 * The board's SQLite migrations for the file that is running right now — the
 * ones that build a board *file of this package's own*. The two layouts this
 * has to survive are `src/migrations-path.ts`'s subject.
 */
export function getBoardSqliteMigrationsPath(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return resolveBoardMigrationsPath(here, MIGRATIONS_DIRECTORY, hasMigrationJournal)
}

/**
 * Create or update a board file this package owns.
 *
 * A host app's own database is not this: there the board is nine tables among
 * the app's own, and the app's migration runner migrates the whole file — which
 * may take two passes, because a migration that rebuilds a table has to drop
 * it with foreign keys off. Nothing here rebuilds anything — `drizzle-sqlite/` starts at the
 * board as it is now and will only ever be appended to — so drizzle's own
 * migrator is the whole of what this needs, and a file that has been migrated
 * before is a no-op by `__drizzle_migrations`.
 *
 * What the file holds afterwards is the board and nothing else: no
 * `workspaces`, no `agents`, no `provider_targets`. Every reference out of the
 * board is a plain text column for exactly that reason (ruling 5-1).
 */
export function migrateBoardFile(database: SqliteDatabase): void {
  migrate(database, { migrationsFolder: getBoardSqliteMigrationsPath() })
}

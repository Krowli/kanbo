import { entityKind } from 'drizzle-orm'
import type { PgliteDatabase } from 'drizzle-orm/pglite'
import { migrate as migratePgliteDatabase } from 'drizzle-orm/pglite/migrator'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { migrate as migratePostgresJsDatabase } from 'drizzle-orm/postgres-js/migrator'

import { getBoardMigrationsPath } from './migrations-path'

/**
 * A Postgres board this package can migrate: the driver an app and the command
 * line connect with, and the embedded one the tests run on. Drizzle ships a
 * migrator per driver, so both are named here rather than one abstract
 * `PgDatabase` — the drivers differ in their result type, and nothing else.
 */
export type MigratablePostgresDatabase<TSchema extends Record<string, unknown> = Record<string, never>>
  = PgliteDatabase<TSchema> | PostgresJsDatabase<TSchema>

/**
 * Bring an external board database up to the schema this build speaks.
 *
 * Unlike a host app's database — whose schema the app migrates itself — an
 * external database has no owner but this package, so this
 * is the one place that creates or updates it. Drizzle records what it applied
 * in `__drizzle_migrations`, which is what makes a second run a no-op.
 */
export async function migrateBoardDatabase<TSchema extends Record<string, unknown>>(
  database: MigratablePostgresDatabase<TSchema>,
): Promise<void> {
  const config = { migrationsFolder: getBoardMigrationsPath() }
  if (isPgliteDatabase(database)) {
    await migratePgliteDatabase(database, config)
    return
  }
  await migratePostgresJsDatabase(database, config)
}

/**
 * Which driver is underneath. Drizzle stamps every one of its classes with a
 * name for exactly this question, and asking it keeps the embedded Postgres out
 * of the packaged command: importing the pglite *driver* to test against would
 * pull the WebAssembly build in with it, while its migrator carries nothing.
 */
function isPgliteDatabase<TSchema extends Record<string, unknown>>(
  database: MigratablePostgresDatabase<TSchema>,
): database is PgliteDatabase<TSchema> {
  return (database.constructor as { [entityKind]?: string })[entityKind] === 'PgliteDatabase'
}

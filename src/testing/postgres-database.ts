import { PGlite } from '@electric-sql/pglite'
import type { PgliteDatabase } from 'drizzle-orm/pglite'
import { drizzle } from 'drizzle-orm/pglite'

import { boardQueryLogger } from '../perf/query-counter'
import { migrateBoardDatabase } from '../postgres/migrate'
import { BOARD_POSTGRES_TABLES, boardPostgresSchema } from '../postgres/schema'
import { BOARD_SCHEMA_EPOCH } from '../schema-epoch'

/** A Postgres board a test owns: the open database, the driver, and the way to throw it away. */
export interface TestPostgresDatabase {
  database: PgliteDatabase<typeof boardPostgresSchema>
  /** The embedded server itself, for a test that needs a statement drizzle will not write. */
  client: PGlite
  /**
   * Empty the board and put it back the way the migration left it — no cards,
   * no history, every sequence back at 1, and `kanban_meta` holding only the
   * two rows the migration seeds.
   *
   * This is what lets one scenario after another share a single embedded
   * Postgres: starting one costs the better part of a second, and a file of
   * thirty scenarios that each start their own pays that thirty times for
   * nothing. It is emptier than a fresh database in one way only — the roles
   * and the triggers `kanbo roles apply` installs survive it, because they
   * belong to the database rather than to the board.
   */
  reset: () => Promise<void>
  dispose: () => Promise<void>
}

/**
 * Everything a scenario can have written, taken back in one statement.
 *
 * `cascade` is what makes the order of the list irrelevant, and `restart
 * identity` puts the `seq` sequences back to 1 so that a scenario reading an
 * insertion order reads the same numbers whether it ran first or last.
 */
const TRUNCATE_BOARD = `truncate ${BOARD_POSTGRES_TABLES.map(table => `"${table}"`).join(', ')} restart identity cascade`

/** The two rows `0000_board.sql` seeds `kanban_meta` with, which `truncate` takes away. */
const SEED_META = `insert into "kanban_meta" ("key", "revision") values ('board', 0), ('schema_epoch', ${BOARD_SCHEMA_EPOCH})`

/**
 * A real Postgres board, migrated to the current schema.
 *
 * It is a real server — `@electric-sql/pglite` is Postgres compiled to
 * WebAssembly, not an emulation of it — so unique indexes, triggers, roles,
 * `on conflict` and transactions behave the way they will against Supabase.
 * It lives in memory and needs no daemon, which is what makes it usable in a
 * unit test and in CI; the price is that each one starts empty, so every test
 * pays for its own migration.
 */
export async function createTestPostgresDatabase(): Promise<TestPostgresDatabase> {
  const client = await PGlite.create()
  const database = drizzle(client, { schema: boardPostgresSchema, logger: boardQueryLogger() })
  await migrateBoardDatabase(database)

  return {
    database,
    client,
    reset: async () => {
      await client.exec(`${TRUNCATE_BOARD}; ${SEED_META};`)
    },
    dispose: async () => {
      await client.close()
    },
  }
}

/**
 * The SQLite board's one seeded row, in a database that does not have it.
 *
 * An external board holds the board and nothing else: there is no `workspaces`
 * table to point at, and the Postgres store never reads one — a workspace id is
 * a value the caller supplies. This exists so a test written against both
 * engines can say the same thing in both, and so the difference is stated once,
 * here, rather than as a missing call somewhere.
 */
export function seedWorkspace(_board: TestPostgresDatabase, id: string): string {
  return id
}

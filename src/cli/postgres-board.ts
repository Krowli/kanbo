import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

import { boardQueryLogger } from '../perf/query-counter'
import { getBoardMigrationsPath } from '../postgres/migrations-path'
import type { BoardPostgresDatabase } from '../postgres/open-database'

/**
 * The one place the command line opens an external board.
 *
 * Everything a command does with a connection lives behind this: the board
 * itself for the store and the schema guard, the migration, and the role
 * script. A command never holds the driver, which is what lets the tests hand
 * the whole thing an embedded Postgres instead — a board in memory answers all
 * three the same way, and a real server is not something a unit test may need.
 */

/** An open external board, and everything a command does with one. */
export interface OpenPostgresBoard {
  /** The board, for the store and for the guard that says whether it is a board at all. */
  database: BoardPostgresDatabase
  /** Bring it up to the schema this build speaks. Running it again does nothing. */
  migrate: () => Promise<void>
  /** Run a script of several statements as it is written — the role SQL is one. */
  runScript: (script: string) => Promise<void>
  close: () => Promise<void>
}

/** How a board is opened from a connection string. */
export type PostgresBoardOpener = (url: string) => Promise<OpenPostgresBoard>

/**
 * How long a connection is given to say goodbye. The command is about to exit
 * either way; the timeout is there so a pooler that has already gone does not
 * hold the process open behind it.
 */
const CLOSE_TIMEOUT_SECONDS = 5

let openerForTests: PostgresBoardOpener | null = null

/**
 * Open the board this connection string names.
 *
 * `prepare: false` because both of Supabase's poolers sit in front of the
 * database and neither carries a prepared statement across a connection, and
 * `max: 1` because a `kanbo` command is one command: a pool of one is the
 * whole of the concurrency there is, and it is also what makes `set role` and
 * a transaction mean what they say.
 */
export async function openPostgresBoard(url: string): Promise<OpenPostgresBoard> {
  return await (openerForTests ?? openWithPostgresJs)(url)
}

async function openWithPostgresJs(url: string): Promise<OpenPostgresBoard> {
  const client = postgres(url, { prepare: false, max: 1 })
  const database = drizzle(client, { logger: boardQueryLogger() })
  return {
    database,
    migrate: async () => {
      await migrate(database, { migrationsFolder: getBoardMigrationsPath() })
    },
    // The role script is many statements and a `do $$ … $$` block, which is
    // the simple query protocol's job rather than a parameterised statement's.
    runScript: async (script: string) => {
      await client.unsafe(script).simple()
    },
    close: async () => {
      await client.end({ timeout: CLOSE_TIMEOUT_SECONDS })
    },
  }
}

/**
 * Hand the commands an already-open board instead of a connection.
 *
 * A `kanbo` test runs the commands in this process against a database it owns,
 * and an embedded Postgres listens on no socket, so there is no connection
 * string that could reach one. This is the seam, and it is deliberately a
 * function rather than an environment variable: a production path that can be
 * switched from outside is a production path that will be.
 */
export function overridePostgresOpenerForTests(opener: PostgresBoardOpener | null): void {
  openerForTests = opener
}

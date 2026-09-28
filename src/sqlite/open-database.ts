import { createRequire } from 'node:module'

import type { Database as SqliteConnection, Options as SqliteConnectionOptions } from 'better-sqlite3'
import { sql } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/sqlite-core'

import { BoardError } from '../domain/errors'
import { boardQueryLogger } from '../perf/query-counter'
import { BOARD_SCHEMA_EPOCH, BOARD_TABLES_ADDED_WITHIN_EPOCH } from '../schema-epoch'
import { boardSqliteSchema } from './schema'
import type { SqliteDatabase } from './transaction'

export { BOARD_SCHEMA_EPOCH }

const require = createRequire(import.meta.url)

/** The tables a board file must already carry for this package to read it. */
const REQUIRED_BOARD_TABLES = ['issue_runs', 'kanban_meta'] as const

/** One open board file: the drizzle handle, the driver beneath it, and the way to let go. */
export interface BoardDatabase {
  database: SqliteDatabase
  connection: SqliteConnection
  close: () => void
}

/**
 * What a caller is told when the native module a board file needs does not
 * load: which Node, system and processor it was tried on — a prebuilt module
 * exists for most, not all — what the loader said, and how to get it back.
 */
export function betterSqlite3MissingMessage(cause: unknown): string {
  const said = cause instanceof Error ? cause.message.split('\n')[0] : String(cause)
  return `Could not load better-sqlite3, which kanbo opens board files with, on Node ${process.version} `
    + `(${process.platform}-${process.arch}): ${said}. Reinstall kanbo with npm install -g kanbo-cli, which brings it along; `
    + 'a program that uses kanbo as a library installs better-sqlite3 itself.'
}

/**
 * `better-sqlite3` is an optional dependency (ruling 5): an install where it
 * could not be built carries no native module, and a Postgres-only or
 * capabilities-only use — or importing `kanbo/sqlite` for a type or for
 * `runSqliteTransaction` — should not demand one. So the require happens here,
 * the one place a board file is actually opened, rather than at the top of
 * this module.
 */
function loadBetterSqlite3(): new (path: string, options?: SqliteConnectionOptions) => SqliteConnection {
  try {
    return require('better-sqlite3')
  }
  catch (error) {
    throw new Error(betterSqlite3MissingMessage(error), { cause: error })
  }
}

/**
 * Drizzle's own better-sqlite3 driver, and why it is not imported at the top of
 * this file like every other import in the package.
 *
 * `drizzle-orm/better-sqlite3` imports the native module eagerly — it has an
 * overload where `drizzle()` constructs the connection itself — so a static
 * import of it makes `better-sqlite3` required by everything that can reach
 * this module, `kanbo capabilities` and `kanbo/mcp` included, and the
 * friendly message above becomes unreachable. A dynamic import keeps the whole
 * chain behind the one call that actually opens a file, which is what makes the
 * optional dependency honest. `createRequire` would be the smaller change and is the
 * wrong one: it would load drizzle's CJS copy beside the ESM one this package
 * already holds, and it would resolve from `node_modules`, which the packaged
 * `dist/cli.cjs` deliberately does not have beside it.
 *
 * The module is remembered after the first load, so a command that opens two
 * board files pays for it once.
 */
let sqliteDriver: typeof import('drizzle-orm/better-sqlite3') | null = null

async function loadSqliteDriver(): Promise<typeof import('drizzle-orm/better-sqlite3')> {
  sqliteDriver ??= await import('drizzle-orm/better-sqlite3')
  return sqliteDriver
}

/**
 * Open a board file with the runtime pragmas a long-running server sets on its
 * own database, so a board read from a terminal behaves the same as one read
 * from inside an app. Migrations are not applied here: the file's owner applies
 * them (`kanbo init --file`, `kanbo migrate`, or the app the database belongs to).
 *
 * Asynchronous because the driver beneath it is loaded on demand — see
 * `loadSqliteDriver`. The native module is asked for first, so an install
 * without it hears the sentence above rather than a module-resolution stack
 * from inside drizzle.
 */
export async function openBoardDatabase(path: string): Promise<BoardDatabase> {
  const Database = loadBetterSqlite3()
  const { drizzle } = await loadSqliteDriver()
  const connection = new Database(path)
  connection.pragma('foreign_keys = ON')
  connection.pragma('journal_mode = WAL')
  connection.pragma('busy_timeout = 5000')
  // NORMAL is the recommended durability tradeoff with WAL (vs FULL fsync on every commit).
  connection.pragma('synchronous = NORMAL')
  return {
    database: drizzle(connection, { schema: boardSqliteSchema, logger: boardQueryLogger() }),
    connection,
    close: () => connection.close(),
  }
}

/**
 * Every column this build expects to find, read off the schema itself — the
 * same idea as the Postgres guard's, so a column a later migration added
 * (`issue_milestones.start_date`) is looked for without being listed again.
 */
function expectedColumns(): string[] {
  return Object.values(boardSqliteSchema).flatMap((table) => {
    const config = getTableConfig(table)
    return config.columns.map(column => `${config.name}.${column.name}`)
  })
}

/**
 * Refuse a board file this build cannot speak for, before any statement runs
 * against it: one with no board in it (`missingTables`), one whose board a
 * later migration has since added a table to (`missingAddedTables`) or a
 * column to (`missingColumns`), and one stamped with another epoch. An app
 * that migrates its own database on start need not call this; it is the guard a
 * standalone reader puts in front of a file it did not create.
 */
export function assertBoardSchema(database: SqliteDatabase): void {
  const present = new Set(database
    .all<{ name: string }>(sql`select name from sqlite_master where type = 'table'`)
    .map(row => row.name))
  const missing = REQUIRED_BOARD_TABLES.filter(table => !present.has(table))
  if (missing.length > 0) {
    throw new BoardError('board_schema_outdated', { missingTables: missing })
  }
  const missingAddedTables = BOARD_TABLES_ADDED_WITHIN_EPOCH.filter(table => !present.has(table))
  if (missingAddedTables.length > 0) {
    throw new BoardError('board_schema_outdated', { missingAddedTables })
  }
  const columns = new Set(database
    .all<{ tableName: string, columnName: string }>(sql`
      select m.name as tableName, p.name as columnName
      from sqlite_master m join pragma_table_info(m.name) p
      where m.type = 'table'`)
    .map(row => `${row.tableName}.${row.columnName}`))
  const missingColumns = expectedColumns().filter(column => !columns.has(column))
  if (missingColumns.length > 0) {
    throw new BoardError('board_schema_outdated', { missingColumns })
  }

  const row = database.get<{ revision: number } | undefined>(
    sql`select revision from kanban_meta where key = 'schema_epoch'`,
  )
  if (row?.revision !== BOARD_SCHEMA_EPOCH) {
    throw new BoardError('board_schema_outdated', { expected: BOARD_SCHEMA_EPOCH, found: row?.revision ?? null })
  }
}

/**
 * Who created this board file's tables from nothing: this package
 * (`kanbo init --file`), or a host app whose own database the board lives in.
 */
export type BoardFileOwner = 'kanbo' | 'host'

/**
 * Which of the two ever wrote this file's board, going by the `kanban_meta`
 * marker `kanbo init --file` leaves behind (ruling 5-4).
 *
 * Absent reads as a host database — every file this package has never
 * touched, and a file this build cannot make sense of at all: `assertBoardSchema` is what says a board is missing or too old,
 * not this, so a table or a row that is not there yet is read as "not this
 * package's file" rather than an error of its own.
 */
export function readBoardFileOwner(database: SqliteDatabase): BoardFileOwner {
  try {
    const row = database.get<{ key: string } | undefined>(
      sql`select key from kanban_meta where key = 'file_owner'`,
    )
    return row ? 'kanbo' : 'host'
  }
  catch {
    return 'host'
  }
}

/**
 * Leave the marker that tells every later reader this file is this package's
 * own, not a host app's. `kanbo init --file` calls this once, right after
 * migrating; `insert or ignore` is what makes calling it again on the same
 * file a no-op rather than a conflict.
 */
export function markBoardFileOwnedByKanbo(database: SqliteDatabase): void {
  database.run(sql`insert or ignore into kanban_meta (key, revision) values ('file_owner', 1)`)
}

/** What a file already holds, before a board is opened on it or written into it. */
export interface BoardFileContents {
  /** No tables at all — a path nothing has been created in yet, or a zero-byte file. */
  empty: boolean
  /** Whose board the tables are, by the `file_owner` marker (ruling 5-4). Says nothing about an empty file. */
  owner: BoardFileOwner
}

/**
 * Look at a file on a connection of its own and hand it back closed, so a
 * caller can decide what to do with it before opening it for real.
 *
 * Two callers, two different decisions off the same two facts: the command line
 * asks whose file it is to know whether a host app's `workspaces` row may be
 * looked up in it, and a host app asks before it writes a board into it, because
 * a file with tables that are not this package's is somebody else's database
 * and migrating it would contaminate it (ruling 5-8).
 *
 * A path that is not a SQLite database at all — a README, a half-downloaded
 * file, a directory — throws, and that is deliberately not the same answer as
 * "a database with somebody else's tables in it": one is a mistake about which
 * path to use and the other is a mistake about which file is a board. No pragma
 * is set and nothing is written, so a file that turns out not to be ours is
 * left exactly as it was found, journal mode included.
 */
export function readBoardFileContents(path: string): BoardFileContents {
  const Database = loadBetterSqlite3()
  const connection = new Database(path, { fileMustExist: true })
  try {
    const tables = connection.prepare('select count(*) as count from sqlite_master where type = \'table\'').get() as { count: number }
    if (tables.count === 0) {
      return { empty: true, owner: 'host' }
    }
    return { empty: false, owner: readMarkedOwner(connection) }
  }
  finally {
    connection.close()
  }
}

/** The marker, read straight off the driver: the same question `readBoardFileOwner` asks a drizzle handle. */
function readMarkedOwner(connection: SqliteConnection): BoardFileOwner {
  try {
    return connection.prepare('select key from kanban_meta where key = \'file_owner\'').get() ? 'kanbo' : 'host'
  }
  catch {
    return 'host'
  }
}

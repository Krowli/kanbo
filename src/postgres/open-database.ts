import { eq, sql } from 'drizzle-orm'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { getTableConfig, pgSchema, text } from 'drizzle-orm/pg-core'

import { BoardError } from '../domain/errors'
import { BOARD_SCHEMA_EPOCH, BOARD_TABLES_ADDED_WITHIN_EPOCH } from '../schema-epoch'
import { BOARD_POSTGRES_TABLES, boardPostgresSchema, kanbanMeta } from './schema'

/**
 * An open Postgres board, whichever driver is underneath.
 *
 * The board is written against `pg-core` and nothing below it, so the same code
 * serves a real connection onto a Supabase database and the embedded
 * Postgres the tests run on. Only the migrator, which drizzle ships per driver,
 * needs to know more than this.
 */
export type BoardPostgresDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>>

/** `information_schema.tables`, the first of the two views the guard reads. */
const informationSchemaTables = pgSchema('information_schema').table('tables', {
  tableSchema: text('table_schema').notNull(),
  tableName: text('table_name').notNull(),
})

/** And `information_schema.columns`, for a board whose tables are all there but older inside. */
const informationSchemaColumns = pgSchema('information_schema').table('columns', {
  tableSchema: text('table_schema').notNull(),
  tableName: text('table_name').notNull(),
  columnName: text('column_name').notNull(),
})

/**
 * Every column this build expects to find, read off the schema itself rather
 * than listed again here — a column added to the schema and forgotten in a
 * migration is exactly the drift this is looking for.
 */
function expectedColumns(): { table: string, column: string }[] {
  return Object.values(boardPostgresSchema).flatMap((table) => {
    const config = getTableConfig(table)
    return config.columns.map(column => ({ table: config.name, column: column.name }))
  })
}

/**
 * Refuse a Postgres board this build cannot speak for, before any statement
 * runs against it.
 *
 * An external database has no app of its own to migrate it — `kanbo migrate`
 * is the only thing that ever creates the board here — so this guard answers
 * three different mistakes with one code: a connection string pointing at a
 * database that has no board in it at all, one pointing at a board whose tables
 * are all there but which a later migration has since added to, and
 * one pointing at a board written by another generation of this package.
 *
 * The middle case is the one a stamp alone cannot catch, and it comes in two
 * shapes: a table a later migration added (`issue_pull_requests`, reported as
 * `missingAddedTables` so a host does not read it as "no board here"), and a
 * column one added. `BOARD_SCHEMA_EPOCH` says which *logical* board a database
 * holds, and a migration that only adds a column this dialect needs for itself — `seq`, the insertion order Postgres
 * has no `rowid` for — does not change that. Such a board would pass a stamp
 * check and then fail on the first listing, statement by statement, so the
 * columns are asked for by name instead.
 */
export async function assertBoardSchema(database: BoardPostgresDatabase): Promise<void> {
  const present = new Set((await database
    .select({ name: informationSchemaTables.tableName })
    .from(informationSchemaTables)
    .where(eq(informationSchemaTables.tableSchema, sql`current_schema()`)))
    .map(row => row.name))
  const added = new Set<string>(BOARD_TABLES_ADDED_WITHIN_EPOCH)
  const missing = BOARD_POSTGRES_TABLES.filter(table => !added.has(table) && !present.has(table))
  if (missing.length > 0) {
    throw new BoardError('board_schema_outdated', { missingTables: missing })
  }
  const missingAddedTables = BOARD_TABLES_ADDED_WITHIN_EPOCH.filter(table => !present.has(table))
  if (missingAddedTables.length > 0) {
    throw new BoardError('board_schema_outdated', { missingAddedTables })
  }

  const columns = new Set((await database
    .select({ table: informationSchemaColumns.tableName, column: informationSchemaColumns.columnName })
    .from(informationSchemaColumns)
    .where(eq(informationSchemaColumns.tableSchema, sql`current_schema()`)))
    .map(row => `${row.table}.${row.column}`))
  const missingColumns = expectedColumns()
    .filter(({ table, column }) => !columns.has(`${table}.${column}`))
    .map(({ table, column }) => `${table}.${column}`)
  if (missingColumns.length > 0) {
    throw new BoardError('board_schema_outdated', { missingColumns })
  }

  const [row] = await database
    .select({ revision: kanbanMeta.revision })
    .from(kanbanMeta)
    .where(eq(kanbanMeta.key, 'schema_epoch'))
  if (row?.revision !== BOARD_SCHEMA_EPOCH) {
    throw new BoardError('board_schema_outdated', { expected: BOARD_SCHEMA_EPOCH, found: row?.revision ?? null })
  }
}

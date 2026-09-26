import { getTableName, is, SQL } from 'drizzle-orm'
import type { AnyPgTable } from 'drizzle-orm/pg-core'
import { getTableConfig as getPgTableConfig } from 'drizzle-orm/pg-core'
import type { AnySQLiteTable } from 'drizzle-orm/sqlite-core'
import { getTableConfig as getSqliteTableConfig } from 'drizzle-orm/sqlite-core'
import { describe, expect, it } from 'vitest'

import {
  issueComments as sqliteIssueComments,
  issueFieldChanges as sqliteIssueFieldChanges,
  issueMilestones as sqliteIssueMilestones,
  issuePullRequests as sqliteIssuePullRequests,
  issueRelations as sqliteIssueRelations,
  issueRuns as sqliteIssueRuns,
  issues as sqliteIssues,
  issueStatuses as sqliteIssueStatuses,
  kanbanMeta as sqliteKanbanMeta,
} from '../sqlite/schema'
import {
  issueComments,
  issueFieldChanges,
  issueMilestones,
  issuePullRequests,
  issueRelations,
  issueRuns,
  issues,
  issueStatuses,
  kanbanMeta,
} from './schema'

/**
 * The board, table by table, in both dialects.
 *
 * Both halves are listed by hand rather than walked, because the point of the
 * check is that the two schemas hold the same tables: a table added to one and
 * forgotten in the other has to show up here, and a loop over one of them would
 * be blind to exactly that.
 */
const BOARD_TABLES: { name: string, sqlite: AnySQLiteTable, postgres: AnyPgTable }[] = [
  { name: 'issue_statuses', sqlite: sqliteIssueStatuses, postgres: issueStatuses },
  { name: 'issue_milestones', sqlite: sqliteIssueMilestones, postgres: issueMilestones },
  { name: 'issues', sqlite: sqliteIssues, postgres: issues },
  { name: 'issue_comments', sqlite: sqliteIssueComments, postgres: issueComments },
  { name: 'issue_runs', sqlite: sqliteIssueRuns, postgres: issueRuns },
  { name: 'issue_relations', sqlite: sqliteIssueRelations, postgres: issueRelations },
  { name: 'issue_field_changes', sqlite: sqliteIssueFieldChanges, postgres: issueFieldChanges },
  { name: 'issue_pull_requests', sqlite: sqliteIssuePullRequests, postgres: issuePullRequests },
  { name: 'kanban_meta', sqlite: sqliteKanbanMeta, postgres: kanbanMeta },
]

/**
 * The columns Postgres has and the file does not, and why.
 *
 * `seq` stands in for the `rowid` SQLite orders same-second rows by. It is the
 * one licence this check grants: anything else that appears on one side and
 * not the other is a drift, and the list is here so that adding to it is a
 * decision someone writes down rather than a test quietly going green.
 */
const POSTGRES_ONLY_COLUMNS: Record<string, string[]> = {
  issue_runs: ['seq'],
  issue_comments: ['seq'],
  issue_field_changes: ['seq'],
  issue_pull_requests: ['seq'],
}

/**
 * Every reference out of the board, in both dialects.
 *
 * A board is carried by three different files — a host app's own, a project's own,
 * an external database — and only one of them has a `workspaces`, an `agents`
 * or a `provider_targets` table to point at. So none of them is a foreign key
 * on either engine any more (ruling 5-1): they are plain text columns, soft
 * references into whichever app is looking, and what an `ON DELETE` would do
 * is done in the open by the app that deletes the row.
 * The columns themselves must still be there, or a card would lose what it
 * pointed at when its board moved.
 */
const SOFT_REFERENCE_COLUMNS: Record<string, string[]> = {
  issue_statuses: ['workspace_id'],
  issue_milestones: ['workspace_id'],
  issues: ['workspace_id', 'delegate_agent_id', 'delegate_provider_target_id'],
}

/**
 * The columns a board keeps in 32 bits.
 *
 * Everything else a SQLite file stores in an `integer` is a unix second or a
 * value that will outgrow 32 bits, and Postgres's `integer` is 32 bits — so the
 * board's Postgres schema says `bigint` for all of them. These five are the
 * genuine exceptions: a card's number, a pull request's number, two board
 * positions and the change counter. The list is written down so that narrowing any *other* column to
 * `integer` — the drift `schema.ts`'s own docstring warns about — is a failure
 * rather than a thing nobody noticed.
 */
const NARROW_COLUMNS: Record<string, string[]> = {
  issue_statuses: ['order'],
  issues: ['number', 'order'],
  issue_pull_requests: ['number'],
  kanban_meta: ['revision'],
}

/**
 * The two dialects' type names, folded into the one vocabulary a board has.
 *
 * `text` is `text` in both. A SQLite `integer` is 64-bit whatever it holds, so
 * it is simply `number`; a Postgres one is 32-bit, and is only `number` where
 * the column is on the list above. Anything else Postgres narrowed reads as
 * `number (32-bit)` and fails against the file's `number` — which is the drift
 * the schema's own docstring warns about, and the reason this is asked at all.
 */
function normalizeType(sqlType: string, narrow: boolean): string {
  switch (sqlType) {
    case 'text':
      return 'text'
    case 'integer':
      return narrow ? 'number' : 'number (32-bit)'
    case 'bigint':
      return 'number'
    default:
      return sqlType
  }
}

/** What a column is, as far as both dialects agree on it. */
interface ComparableColumn {
  type: string
  notNull: boolean
  primary: boolean
  hasDefault: boolean
  /** A literal default, compared; a dialect's own SQL expression is not comparable and reads `sql`. */
  default: unknown
  enumValues: readonly string[] | undefined
}

function describeColumn(column: {
  name: string
  notNull: boolean
  primary: boolean
  hasDefault: boolean
  default: unknown
  enumValues?: readonly string[]
  getSQLType: () => string
}, options: { sqlite: boolean, narrowColumns: string[] }): ComparableColumn {
  return {
    // A file's integers are all 64-bit, so the list is only asked of Postgres.
    type: normalizeType(column.getSQLType(), options.sqlite || options.narrowColumns.includes(column.name)),
    notNull: column.notNull,
    primary: column.primary,
    hasDefault: column.hasDefault,
    default: is(column.default, SQL) ? 'sql' : column.default,
    enumValues: column.enumValues,
  }
}

function columnsOf(table: AnySQLiteTable | AnyPgTable, skip: string[] = []): Record<string, ComparableColumn> {
  const sqlite = !('enableRLS' in table)
  const config = sqlite
    ? getSqliteTableConfig(table as AnySQLiteTable)
    : getPgTableConfig(table as AnyPgTable)
  const narrowColumns = NARROW_COLUMNS[config.name] ?? []
  return Object.fromEntries(
    config.columns
      .filter(column => !skip.includes(column.name))
      .map(column => [column.name, describeColumn(column, { sqlite, narrowColumns })]),
  )
}

/** Index and unique-index names, with the columns each one is on. */
function indexesOf(table: AnySQLiteTable | AnyPgTable): Record<string, { unique: boolean, columns: string[] }> {
  const config = 'enableRLS' in table
    ? getPgTableConfig(table as AnyPgTable)
    : getSqliteTableConfig(table as AnySQLiteTable)
  return Object.fromEntries(config.indexes.map((index) => {
    const built = index.config as { name?: string, unique: boolean, columns: { name?: string }[] }
    return [built.name ?? '(unnamed)', {
      unique: built.unique,
      columns: built.columns.map(column => column.name ?? '(expression)'),
    }]
  }))
}

/** Which column points at which table — which, now, is only ever another board table. */
function foreignKeysOf(table: AnySQLiteTable | AnyPgTable): string[] {
  const config = 'enableRLS' in table
    ? getPgTableConfig(table as AnyPgTable)
    : getSqliteTableConfig(table as AnySQLiteTable)
  return config.foreignKeys
    .map((key) => {
      const reference = key.reference()
      const from = reference.columns.map(column => column.name).join(',')
      const to = reference.foreignColumns.map(column => `${getTableName(column.table)}.${column.name}`).join(',')
      return `${from} -> ${to} on delete ${key.onDelete ?? 'no action'}`
    })
    .sort()
}

/**
 * The two dialects are one schema, checked rather than remembered.
 *
 * The migration chains that build this board — `drizzle-sqlite/` into a board
 * file of a project's own, `drizzle-postgres/` into an external database, and
 * a host app's own chain into its database — are generated from two schema
 * declarations: `src/sqlite/schema.ts` (which a host app re-exports as its own
 * table objects) and `src/postgres/schema.ts`. So those two declarations are what has to be
 * compared, and this is where. A card that moves between the engines has to
 * come out the same card, so a column added on one side alone, a nullability
 * that drifts, or an enum member that exists in one dialect is a defect these
 * assertions name at the moment it is written rather than at the moment a board
 * is moved. That a host app's chain really does share the SQLite declaration is
 * the host's to check, because only it can see both.
 */
describe('the board schema, in both dialects', () => {
  it('holds the same nine tables on both engines', () => {
    expect(BOARD_TABLES.map(table => table.name)).toEqual([
      'issue_statuses',
      'issue_milestones',
      'issues',
      'issue_comments',
      'issue_runs',
      'issue_relations',
      'issue_field_changes',
      'issue_pull_requests',
      'kanban_meta',
    ])

    for (const table of BOARD_TABLES) {
      expect(getSqliteTableConfig(table.sqlite).name).toBe(table.name)
      expect(getPgTableConfig(table.postgres).name).toBe(table.name)
    }
  })

  it.each(BOARD_TABLES)('$name has the same columns in both dialects', ({ name, sqlite, postgres }) => {
    expect(columnsOf(postgres, POSTGRES_ONLY_COLUMNS[name] ?? [])).toEqual(columnsOf(sqlite))
  })

  it.each(BOARD_TABLES)('$name carries the same indexes in both dialects', ({ sqlite, postgres }) => {
    expect(indexesOf(postgres)).toEqual(indexesOf(sqlite))
  })

  it.each(BOARD_TABLES)('$name keeps the board\'s own foreign keys in both dialects', ({ sqlite, postgres }) => {
    expect(foreignKeysOf(postgres)).toEqual(foreignKeysOf(sqlite))
  })

  it('carries every reference out of the board as a plain column on both engines', () => {
    // The columns must still be there and must still not be constraints — the
    // first half is what a card keeps when its board moves, the second is what
    // lets a board live in a file that has no host app in it (ruling 5-1).
    for (const [table, columns] of Object.entries(SOFT_REFERENCE_COLUMNS)) {
      const entry = BOARD_TABLES.find(candidate => candidate.name === table)
      expect(entry, `${table} is not one of the board tables`).toBeDefined()
      for (const column of columns) {
        expect(columnsOf(entry!.postgres)[column], `postgres ${table}.${column}`).toBeDefined()
        expect(columnsOf(entry!.sqlite)[column], `sqlite ${table}.${column}`).toBeDefined()
      }
      for (const key of [...foreignKeysOf(entry!.sqlite), ...foreignKeysOf(entry!.postgres)]) {
        expect(columns.some(column => key.startsWith(`${column} ->`)), `${table}: ${key}`).toBe(false)
      }
    }
  })
})

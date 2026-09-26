import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { afterEach, describe, expect, it } from 'vitest'

import { BoardError } from '../domain/errors'
import type { TestPostgresDatabase } from '../testing/postgres-database'
import { createTestPostgresDatabase } from '../testing/postgres-database'
import { migrateBoardDatabase } from './migrate'
import { assertBoardSchema } from './open-database'
import { BOARD_POSTGRES_TABLES, boardPostgresSchema, issues, kanbanMeta } from './schema'

const WORKSPACE = 'ws-postgres-schema'

describe('the board schema in Postgres', () => {
  let board: TestPostgresDatabase | undefined

  afterEach(async () => {
    await board?.dispose()
    board = undefined
  })

  it('creates every table the board is made of', async () => {
    board = await createTestPostgresDatabase()

    const rows = await board.client.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = current_schema()`,
    )
    const present = rows.rows.map(row => row.table_name)

    expect(BOARD_POSTGRES_TABLES).toHaveLength(Object.keys(boardPostgresSchema).length)
    for (const table of BOARD_POSTGRES_TABLES) {
      expect(present).toContain(table)
    }
  })

  it('stamps the database with the schema generation this build speaks', async () => {
    board = await createTestPostgresDatabase()

    const rows = await board.database.select().from(kanbanMeta)

    expect(rows.map(row => [row.key, row.revision])).toEqual(
      expect.arrayContaining([['board', 0], ['schema_epoch', 1]]),
    )
  })

  it('applies the same migrations twice without a word', async () => {
    board = await createTestPostgresDatabase()

    await expect(migrateBoardDatabase(board.database)).resolves.toBeUndefined()

    const rows = await board.database.select().from(kanbanMeta)
    expect(rows.filter(row => row.key === 'schema_epoch')).toHaveLength(1)
  })

  it('refuses a second card with a number the board already gave out', async () => {
    board = await createTestPostgresDatabase()
    await board.database.insert(issues).values({ id: 'issue-1', workspaceId: WORKSPACE, number: 1, title: 'First' })

    const failure = await board.database
      .insert(issues)
      .values({ id: 'issue-2', workspaceId: WORKSPACE, number: 1, title: 'Second' })
      .then(() => undefined, (error: Error) => error)

    // Drizzle wraps the driver's error, so the index that refused is on the cause.
    expect((failure?.cause as { constraint?: string } | undefined)?.constraint)
      .toBe('issues_workspace_number_unique')
  })

  it('lets the same number stand on two different boards', async () => {
    board = await createTestPostgresDatabase()

    await board.database.insert(issues).values([
      { id: 'issue-1', workspaceId: WORKSPACE, number: 1, title: 'First' },
      { id: 'issue-2', workspaceId: 'ws-other', number: 1, title: 'Also first' },
    ])

    expect(await board.database.select({ id: issues.id }).from(issues)).toHaveLength(2)
  })

  it('turns away a board whose tables are all there but which a migration has since added a column to', async () => {
    board = await createTestPostgresDatabase()
    // What a board created by an earlier build looks like from here: every
    // table present, the stamp still saying epoch 1 — because the logical board
    // did not change — and one column this build orders its listings by gone.
    await board.client.exec('alter table "issue_comments" drop column "seq"')

    const failure = await assertBoardSchema(board.database).then(() => undefined, (error: Error) => error)

    expect(failure).toBeInstanceOf(BoardError)
    expect((failure as BoardError).details).toEqual({ missingColumns: ['issue_comments.seq'] })
  })

  it('turns away a board that predates the sprint start a milestone carries', async () => {
    board = await createTestPostgresDatabase()
    await board.client.exec('alter table "issue_milestones" drop column "start_date"')

    const failure = await assertBoardSchema(board.database).then(() => undefined, (error: Error) => error)

    expect(failure).toBeInstanceOf(BoardError)
    expect((failure as BoardError).details).toEqual({ missingColumns: ['issue_milestones.start_date'] })
  })

  it('turns away a board that predates the entry rules a column carries', async () => {
    board = await createTestPostgresDatabase()
    await board.client.exec('alter table "issue_statuses" drop column "entry_rules"')

    const failure = await assertBoardSchema(board.database).then(() => undefined, (error: Error) => error)

    expect(failure).toBeInstanceOf(BoardError)
    expect((failure as BoardError).details).toEqual({ missingColumns: ['issue_statuses.entry_rules'] })
  })

  it('turns away a board that predates a table added within the epoch, as an older board rather than no board', async () => {
    board = await createTestPostgresDatabase()
    await board.client.exec('drop table "issue_pull_requests"')

    const failure = await assertBoardSchema(board.database).then(() => undefined, (error: Error) => error)

    expect(failure).toBeInstanceOf(BoardError)
    expect((failure as BoardError).details).toEqual({ missingAddedTables: ['issue_pull_requests'] })
  })

  it('accepts a migrated database and turns away one with no board in it', async () => {
    board = await createTestPostgresDatabase()
    await expect(assertBoardSchema(board.database)).resolves.toBeUndefined()

    const empty = await PGlite.create()
    try {
      await expect(assertBoardSchema(drizzle(empty))).rejects.toThrow(BoardError)
    }
    finally {
      await empty.close()
    }
  })
})

// Ruling 5-3. `SqliteDatabase` asks for `Record<string, unknown>` rather than
// any particular schema, and the thing that could quietly break is not a
// statement but an assignment: a host app hands its own handle in, typed with
// every table it has, and a generic that stopped accepting it would surface as
// a compile error in that app rather than here. So both handles are built and handed over, and the board is
// really read through each.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { int, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { afterEach, describe, expect, it } from 'vitest'

import { createSqliteBoardStore } from './board-store.sqlite'
import { migrateBoardFile } from './migrate'
import { openBoardDatabase } from './open-database'
import { boardSqliteSchema } from './schema'
import type { SqliteDatabase } from './transaction'

/**
 * A stand-in for a host app's own schema: the board's tables plus tables that are
 * none of this package's business. The shape a host hands over is restated
 * here, and `workspaces` is spelled the way the command line reads it by name.
 */
const hostSchema = {
  ...boardSqliteSchema,
  workspaces: sqliteTable('workspaces', {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    identifier: text('identifier').notNull().default(''),
    locatorJson: text('locator_json').notNull(),
    pinned: int('pinned').notNull().default(0),
  }),
  sessions: sqliteTable('sessions', {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
  }),
}

const directories: string[] = []

function newBoardFile(): string {
  const directory = mkdtempSync(join(tmpdir(), 'kanbo-board-type-'))
  directories.push(directory)
  return join(directory, 'board.db')
}

describe('the database handle the board accepts', () => {
  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { force: true, recursive: true })
    }
  })

  it('takes a handle drizzle was given a host’s whole schema', async () => {
    const connection = new Database(newBoardFile())
    connection.pragma('foreign_keys = ON')
    const host: BetterSQLite3Database<typeof hostSchema> = drizzle(connection, { schema: hostSchema })
    migrateBoardFile(host)

    // The assignment is the assertion: this line is what a host app's own
    // `createSqliteBoardStore({ database: () => db() })` does.
    const database: SqliteDatabase = host
    const store = createSqliteBoardStore({ database: () => database })
    await store.statuses.create({ id: 'st', workspaceId: 'ws', name: 'To Do' })

    expect((await store.statuses.listByWorkspace('ws')).map(status => status.name)).toEqual(['To Do'])
    connection.close()
  })

  it('takes the handle this package opens onto a board file of its own', async () => {
    const board = await openBoardDatabase(newBoardFile())
    migrateBoardFile(board.database)

    const database: SqliteDatabase = board.database
    const store = createSqliteBoardStore({ database: () => database })
    await store.statuses.create({ id: 'st', workspaceId: 'ws', name: 'To Do' })

    expect((await store.statuses.listByWorkspace('ws')).map(status => status.name)).toEqual(['To Do'])
    board.close()
  })
})

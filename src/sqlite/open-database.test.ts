import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { BoardError } from '../domain/errors'
import { migrateBoardFile } from './migrate'
import { assertBoardSchema, markBoardFileOwnedByKanbo, openBoardDatabase, readBoardFileOwner } from './open-database'

describe('openBoardDatabase', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'kanbo-board-'))
  })

  afterEach(() => {
    rmSync(directory, { force: true, recursive: true })
  })

  it('applies the runtime pragmas a board file is read with', async () => {
    const board = await openBoardDatabase(join(directory, 'board.db'))
    try {
      expect(board.connection.pragma('journal_mode', { simple: true })).toBe('wal')
      expect(board.connection.pragma('foreign_keys', { simple: true })).toBe(1)
      expect(board.connection.pragma('busy_timeout', { simple: true })).toBe(5000)
      expect(board.connection.pragma('synchronous', { simple: true })).toBe(1)
    }
    finally {
      board.close()
    }
  })
})

describe('assertBoardSchema', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'kanbo-board-schema-'))
  })

  afterEach(() => {
    rmSync(directory, { force: true, recursive: true })
  })

  // The `schema_epoch` row `assertBoardSchema` reads is seeded by hand in
  // `drizzle-sqlite/0000_board.sql` rather than generated, and drizzle-kit
  // drops hand-written statements on regeneration (see the folder's own
  // README) — nothing else would catch a regeneration that forgot it.
  it('accepts a freshly migrated board file — the hand-seeded schema_epoch row survives regeneration', async () => {
    const board = await openBoardDatabase(join(directory, 'board.db'))
    try {
      migrateBoardFile(board.database)
      expect(() => assertBoardSchema(board.database)).not.toThrow()
    }
    finally {
      board.close()
    }
  })

  it('turns away a file whose board predates a table added within the epoch, as an older board rather than no board', async () => {
    const board = await openBoardDatabase(join(directory, 'board.db'))
    try {
      migrateBoardFile(board.database)
      // A file migrated before 0001: every founding table, the epoch-1 stamp,
      // and no pull-request links. A host reads `missingTables` as "no board
      // here", so this must not say that.
      board.connection.exec('drop table issue_pull_requests')

      let failure: unknown
      try {
        assertBoardSchema(board.database)
      }
      catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(BoardError)
      expect((failure as BoardError).details).toEqual({ missingAddedTables: ['issue_pull_requests'] })
    }
    finally {
      board.close()
    }
  })

  it('turns away a file whose board predates a column added within the epoch', async () => {
    const board = await openBoardDatabase(join(directory, 'board.db'))
    try {
      migrateBoardFile(board.database)
      // A file migrated before 0002: the stamp still says epoch 1, and the
      // sprint start a milestone now carries is not there.
      board.connection.exec('alter table issue_milestones drop column start_date')

      let failure: unknown
      try {
        assertBoardSchema(board.database)
      }
      catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(BoardError)
      expect((failure as BoardError).details).toEqual({ missingColumns: ['issue_milestones.start_date'] })
    }
    finally {
      board.close()
    }
  })

  it('turns away a file whose columns predate their entry rules', async () => {
    const board = await openBoardDatabase(join(directory, 'board.db'))
    try {
      migrateBoardFile(board.database)
      // A file migrated before 0003: the stamp still says epoch 1, and the
      // entry rules a column now carries are not there.
      board.connection.exec('alter table issue_statuses drop column entry_rules')

      let failure: unknown
      try {
        assertBoardSchema(board.database)
      }
      catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(BoardError)
      expect((failure as BoardError).details).toEqual({ missingColumns: ['issue_statuses.entry_rules'] })
    }
    finally {
      board.close()
    }
  })
})

describe('readBoardFileOwner', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'kanbo-board-owner-'))
  })

  afterEach(() => {
    rmSync(directory, { force: true, recursive: true })
  })

  it('reads "host" off a migrated file with no marker', async () => {
    const board = await openBoardDatabase(join(directory, 'board.db'))
    try {
      migrateBoardFile(board.database)
      expect(readBoardFileOwner(board.database)).toBe('host')
    }
    finally {
      board.close()
    }
  })

  it('reads "kanbo" once markBoardFileOwnedByKanbo has run, and stays "kanbo" if it runs again', async () => {
    const board = await openBoardDatabase(join(directory, 'board.db'))
    try {
      migrateBoardFile(board.database)
      markBoardFileOwnedByKanbo(board.database)
      markBoardFileOwnedByKanbo(board.database)
      expect(readBoardFileOwner(board.database)).toBe('kanbo')
    }
    finally {
      board.close()
    }
  })

  it('reads "host" off a file with no board in it at all, rather than throwing', async () => {
    const board = await openBoardDatabase(join(directory, 'empty.db'))
    try {
      expect(readBoardFileOwner(board.database)).toBe('host')
    }
    finally {
      board.close()
    }
  })
})

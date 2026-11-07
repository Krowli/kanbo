import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Command } from 'commander'
import { sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BoardStore } from '../board-store'
import type { BoardWorkspaceIdentity } from '../domain/numbering'
import { createCard } from '../ops/cards'
import type { BoardActor } from '../ops/types'
import { createSqliteBoardStore } from '../sqlite/board-store.sqlite'
import { markBoardFileOwnedByKanbo } from '../sqlite/open-database'
import type { TestBoardDatabase } from '../testing/board-database'
import { createTestBoardDatabase, seedHostWorkspace } from '../testing/board-database'
import { writeBinding } from './binding'
import { registerApproveCommand } from './commands/approve'
import { registerBoardCommand } from './commands/board'
import { FILE_SCHEMA_OUTDATED_MESSAGE, SCHEMA_OUTDATED_MESSAGE } from './schema-guard'

const WORKSPACE: BoardWorkspaceIdentity = { id: 'workspace', identifier: 'WOR', name: 'Workspace' }
const USER: BoardActor = { kind: 'user', id: '__self__' }

describe('a board file older than this build', () => {
  let board: TestBoardDatabase
  let store: BoardStore

  beforeEach(async () => {
    board = await createTestBoardDatabase()
    seedHostWorkspace(board, WORKSPACE.id, WORKSPACE.identifier)
    store = createSqliteBoardStore({ database: () => board.database })
    for (const name of ['KANBO_DB_PATH', 'KANBO_WORKSPACE_ID']) {
      vi.stubEnv(name, undefined)
    }
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    board.dispose()
  })

  /** The same file, stamped with a schema generation this build does not speak. */
  function ageTheDatabase(): void {
    board.database.run(sql`update kanban_meta set revision = 0 where key = 'schema_epoch'`)
  }

  /** The same file a migration behind: the columns 0005 added are not there. */
  function dropTheNewestColumns(): void {
    board.connection.exec('alter table issue_statuses drop column wip_limit')
    board.connection.exec('alter table issue_statuses drop column allowed_from')
  }

  async function run(argv: string[]): Promise<string[]> {
    const printed: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      printed.push(String(line))
    })
    const program = new Command().exitOverride()
    registerBoardCommand(program)
    registerApproveCommand(program)
    await program.parseAsync([...argv, '--db', board.path, '--workspace', WORKSPACE.id], { from: 'user' })
    return printed
  }

  it('refuses a write, and leaves the card exactly as it was', async () => {
    const card = await createCard(store, { workspace: WORKSPACE, title: 'Card', statusName: 'To Do' }, USER)
    ageTheDatabase()

    const refusal = expect.objectContaining({ exitCode: 3, message: SCHEMA_OUTDATED_MESSAGE })
    await expect(run(['approve', card.id])).rejects.toThrowError(refusal)
    expect((await store.issues.findById(card.id))?.statusId).toBe(card.statusId)
  })

  it('still lets a person read their cards', async () => {
    await createCard(store, { workspace: WORKSPACE, title: 'Card', statusName: 'To Do' }, USER)
    ageTheDatabase()

    expect((await run(['board'])).join('\n')).toContain('Card')
  })

  it('refuses a read the file lacks a column for with the sentence a write gets, not the driver\'s', async () => {
    await createCard(store, { workspace: WORKSPACE, title: 'Card', statusName: 'To Do' }, USER)
    dropTheNewestColumns()

    await expect(run(['board'])).rejects.toThrowError(expect.objectContaining({ exitCode: 3, message: SCHEMA_OUTDATED_MESSAGE }))
  })

  it('names kanbo migrate when the file a migration behind is kanbo\'s own', async () => {
    markBoardFileOwnedByKanbo(board.database)
    dropTheNewestColumns()

    await expect(run(['board'])).rejects.toThrowError(expect.objectContaining({ exitCode: 3, message: FILE_SCHEMA_OUTDATED_MESSAGE }))
  })
})

/** A folder with no board of its own, and an app's database that only `KANBO_DB_PATH` names. */
describe('a host database named by KANBO_DB_PATH alone', () => {
  let board: TestBoardDatabase
  let projectDir: string

  beforeEach(async () => {
    board = await createTestBoardDatabase()
    seedHostWorkspace(board, 'other-workspace', 'OTH')
    projectDir = mkdtempSync(join(tmpdir(), 'kanbo-env-only-'))
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir)
    for (const name of ['KANBO_WORKSPACE_ID', 'KANBO_DATABASE_URL']) {
      vi.stubEnv(name, undefined)
    }
    vi.stubEnv('KANBO_DB_PATH', board.path)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    board.dispose()
    rmSync(projectDir, { force: true, recursive: true })
  })

  function dropTheNewestColumns(): void {
    board.connection.exec('alter table issue_statuses drop column wip_limit')
    board.connection.exec('alter table issue_statuses drop column allowed_from')
  }

  async function runBoard(...extra: string[]): Promise<void> {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const program = new Command().exitOverride()
    registerBoardCommand(program)
    await program.parseAsync(['board', ...extra], { from: 'user' })
  }

  it('says the folder has no board of its own when the database is older than this kanbo', async () => {
    dropTheNewestColumns()

    await expect(runBoard()).rejects.toThrowError(expect.objectContaining({
      exitCode: 3,
      message: `This folder has no kanbo board of its own. KANBO_DB_PATH points at another app's database (${board.path}), `
        + 'which is older than this kanbo. To give this folder its own board, run kanbo init here.',
    }))
  })

  it('keeps the app\'s sentence when --db names that database', async () => {
    dropTheNewestColumns()

    await expect(runBoard('--db', board.path)).rejects.toThrowError(expect.objectContaining({ exitCode: 3, message: SCHEMA_OUTDATED_MESSAGE }))
  })

  it('keeps the app\'s sentence when the folder is bound to that database', async () => {
    dropTheNewestColumns()
    writeBinding(projectDir, { schemaVersion: 1, workspaceId: 'other-workspace' })

    await expect(runBoard()).rejects.toThrowError(expect.objectContaining({ exitCode: 3, message: SCHEMA_OUTDATED_MESSAGE }))
  })

  it('says the folder has no board of its own when a current database has no project for it', async () => {
    await expect(runBoard()).rejects.toThrowError(expect.objectContaining({
      exitCode: 2,
      message: `This folder has no kanbo board of its own. KANBO_DB_PATH points at another app's database (${board.path}), `
        + 'which has no project for this folder. To give this folder its own board, run kanbo init here.',
    }))
  })
})

import { Command } from 'commander'
import { sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BoardStore } from '../board-store'
import type { BoardWorkspaceIdentity } from '../domain/numbering'
import { createCard } from '../ops/cards'
import type { BoardActor } from '../ops/types'
import { createSqliteBoardStore } from '../sqlite/board-store.sqlite'
import type { TestBoardDatabase } from '../testing/board-database'
import { createTestBoardDatabase, seedHostWorkspace } from '../testing/board-database'
import { registerCardCommands } from './commands/card'
import { SCHEMA_OUTDATED_MESSAGE } from './schema-guard'

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

  async function run(argv: string[]): Promise<string[]> {
    const printed: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      printed.push(String(line))
    })
    const program = new Command().exitOverride()
    registerCardCommands(program)
    await program.parseAsync([...argv, '--db', board.path, '--workspace', WORKSPACE.id], { from: 'user' })
    return printed
  }

  it('refuses a write, and leaves the card exactly as it was', async () => {
    const card = await createCard(store, { workspace: WORKSPACE, title: 'Card', statusName: 'To Do' }, USER)
    ageTheDatabase()

    const refusal = expect.objectContaining({ exitCode: 3, message: SCHEMA_OUTDATED_MESSAGE })
    await expect(run(['card', 'move', card.id, 'in_progress'])).rejects.toThrowError(refusal)
    expect((await store.issues.findById(card.id))?.statusId).toBe(card.statusId)
  })

  it('still lets a person read their cards', async () => {
    await createCard(store, { workspace: WORKSPACE, title: 'Card', statusName: 'To Do' }, USER)
    ageTheDatabase()

    expect((await run(['card', 'list'])).join('\n')).toContain('Card')
  })
})

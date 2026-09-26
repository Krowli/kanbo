import { afterAll } from 'vitest'

import { runBoardStoreContract } from '../testing/board-store-contract'
import type { TestPostgresDatabase } from '../testing/postgres-database'
import { createTestPostgresDatabase, seedWorkspace } from '../testing/postgres-database'
import { createPostgresBoardStore } from './board-store.postgres'

/**
 * The same scenarios the board file answers, answered by a database.
 *
 * Nothing here is written twice: the scenarios live with the first
 * implementation that had to satisfy them, and this file is only the factory
 * that opens a Postgres board instead of a file. A difference between the two
 * stores therefore shows up as a scenario failing on one engine, which is the
 * whole point of running them both.
 *
 * One embedded Postgres serves the whole file and each scenario empties it
 * again: starting a server costs about as much as running all of these
 * scenarios put together, and `reset()` leaves a board no scenario can tell
 * from a freshly migrated one.
 */
let board: TestPostgresDatabase | undefined

afterAll(async () => {
  await board?.dispose()
  board = undefined
})

runBoardStoreContract('PostgresBoardStore', async () => {
  board ??= await createTestPostgresDatabase()
  const open = board
  await open.reset()

  return {
    store: createPostgresBoardStore({ database: open.database }),
    // An external board has no `workspaces` table to seed — a workspace id is a
    // value the caller supplies — so this only names the two the scenarios use.
    workspaceId: seedWorkspace(open, 'workspace-a'),
    secondWorkspaceId: seedWorkspace(open, 'workspace-b'),
    // The board outlives the scenario; its rows do not.
    dispose: async () => {
      await open.reset()
    },
  }
})

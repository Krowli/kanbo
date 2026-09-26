import { createTestBoardDatabase, seedWorkspace } from '../testing/board-database'
import { runBoardStoreContract } from '../testing/board-store-contract'
import { createSqliteBoardStore } from './board-store.sqlite'

/** The board scenarios, answered by a board file. */
runBoardStoreContract('SqliteBoardStore', async () => {
  const board = await createTestBoardDatabase()
  seedWorkspace(board, 'workspace-a', 'WSA')
  seedWorkspace(board, 'workspace-b', 'WSB')

  return {
    store: createSqliteBoardStore({ database: () => board.database }),
    workspaceId: 'workspace-a',
    secondWorkspaceId: 'workspace-b',
    dispose: board.dispose,
  }
})

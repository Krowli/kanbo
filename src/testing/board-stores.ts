import type { BoardStore } from '../board-store'
import { createPostgresBoardStore } from '../postgres/board-store.postgres'
import { createSqliteBoardStore } from '../sqlite/board-store.sqlite'
import { createTestBoardDatabase, seedWorkspace } from './board-database'
import { createTestPostgresDatabase } from './postgres-database'

/** A workspace the cards of a test hang off. */
export interface TestWorkspaceSeed {
  id: string
  /** The prefix card keys are built from — `WOR` in `WOR-001`. */
  identifier?: string
}

/** A board a test owns, whichever engine holds it. */
export interface TestBoardStore {
  store: BoardStore
  /** Close the board and throw away whatever was holding it. */
  dispose: () => Promise<void>
}

/** One engine a board can live in, as a test opens it. */
export interface TestBoardStoreFactory {
  /** How the engine reads in the test title. */
  name: string
  open: (workspaces: TestWorkspaceSeed[]) => Promise<TestBoardStore>
}

/**
 * Both engines a board can live in.
 *
 * An operation test that runs over this list runs twice, once per store:
 * everything in `ops` is written against the `BoardStore` interface and nothing
 * below it, so a test that passes on one engine and fails on the other has
 * found a difference the interface was supposed to hide — which is exactly what
 * a second implementation needs watching for. A test that is genuinely about a
 * file — a second connection onto one, say — opens the file itself instead of
 * asking here.
 */
export const BOARD_STORE_FACTORIES: TestBoardStoreFactory[] = [
  {
    name: 'sqlite',
    open: async (workspaces) => {
      const board = await createTestBoardDatabase()
      for (const workspace of workspaces) {
        seedWorkspace(board, workspace.id, workspace.identifier)
      }
      return {
        store: createSqliteBoardStore({ database: () => board.database }),
        dispose: async () => {
          board.dispose()
        },
      }
    },
  },
  {
    name: 'postgres',
    // The workspaces are not seeded here and do not need to be: an external
    // board holds the board and nothing else, so a workspace id is a value the
    // caller supplies rather than a row to point at.
    open: async () => {
      const board = await createTestPostgresDatabase()
      return {
        store: createPostgresBoardStore({ database: board.database }),
        dispose: board.dispose,
      }
    },
  },
]

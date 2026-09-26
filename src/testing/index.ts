/**
 * The boards a test opens, for tests written outside this package.
 *
 * Everything here builds a real board and throws it away again — a SQLite file
 * in a temporary directory, an embedded Postgres in memory — because a fake
 * store would test the fake. A host app's tests reach for it so a scenario
 * about an external board runs against Postgres rather than against a mock of
 * one, and `@electric-sql/pglite` stays a development dependency of this
 * package alone: it is resolved from here, by whoever imports this entry.
 */

export { createTestBoardDatabase, seedHostWorkspace, seedWorkspace, type TestBoardDatabase } from './board-database'
export {
  BOARD_STORE_FACTORIES,
  type TestBoardStore,
  type TestBoardStoreFactory,
  type TestWorkspaceSeed,
} from './board-stores'
export { createTestPostgresDatabase, type TestPostgresDatabase } from './postgres-database'

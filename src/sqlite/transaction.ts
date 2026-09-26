import type { Database as SqliteConnection } from 'better-sqlite3'
import { sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

/**
 * The database handle itself — what the host hands the board — and not an open
 * transaction on it: the helper reaches for the driver connection, which a
 * drizzle `SQLiteTransaction` does not carry.
 *
 * The schema parameter is `Record<string, unknown>` rather than any particular
 * schema, which is what lets one type stand for all three of the files a board
 * can live in (ruling 5-3): a handle drizzle was given a host app's whole schema
 * satisfies it, and so does one given only the board's own nine tables. The
 * board never reaches for `database.query`, so the relational builder those
 * generics shape is not something this package gives up by asking for less —
 * `src/sqlite/database-type.test.ts` is the probe that says both handles still
 * arrive here.
 */
export type SqliteDatabase = BetterSQLite3Database<Record<string, unknown>>

/**
 * The better-sqlite3 handle Drizzle keeps beside the query builder. `drizzle()`
 * attaches it as `$client` (`drizzle-orm/better-sqlite3/driver.js`), but the
 * handle is declared as a `BetterSQLite3Database`, a class that does not
 * declare `$client` — which is why the assertion below restates the shape by
 * hand. Its `inTransaction` is the only honest answer to "is a
 * transaction already open", including one this module did not open.
 */
function readSqliteConnection(database: SqliteDatabase): SqliteConnection {
  return (database as SqliteDatabase & { $client: SqliteConnection }).$client
}

/** The statements that open, keep and undo one transaction scope. */
interface TransactionScope {
  begin: string
  commit: string
  undo: string
  /** A savepoint has to be released after its rollback; the outer scope has not. */
  releaseAfterUndo: string | null
}

/**
 * One fixed name for every nested scope, the way better-sqlite3 names its own
 * (`lib/methods/transaction.js`). `release` and `rollback to` address the
 * innermost savepoint carrying the name, and these scopes are opened and closed
 * in stack order, so each call reaches its own — a counter in the name would
 * only repeat what SQLite already tracks, and would collide the moment two
 * scopes nested through different code paths.
 */
const SAVEPOINT_NAME = 'kanbo_tx'

/**
 * How the outer `begin` takes its write lock. `deferred` — the SQLite default —
 * waits for the first write; `immediate` takes the lock up front, so two
 * processes racing for the same file fail fast instead of half-way through.
 * A nested scope is a savepoint and takes no lock of its own, so the mode only
 * reaches the outer statement.
 */
export type SqliteTransactionMode = 'deferred' | 'immediate'

function readTransactionScope(connection: SqliteConnection, mode: SqliteTransactionMode): TransactionScope {
  if (!connection.inTransaction) {
    return {
      begin: mode === 'immediate' ? 'begin immediate' : 'begin',
      commit: 'commit',
      undo: 'rollback',
      releaseAfterUndo: null,
    }
  }
  return {
    begin: `savepoint ${SAVEPOINT_NAME}`,
    commit: `release ${SAVEPOINT_NAME}`,
    undo: `rollback to ${SAVEPOINT_NAME}`,
    releaseAfterUndo: `release ${SAVEPOINT_NAME}`,
  }
}

/**
 * Run `fn` inside one SQLite transaction that is allowed to await.
 *
 * `database.transaction(...)` cannot serve here: it commits the moment its
 * callback returns, and an async callback returns a pending promise, so the
 * transaction would close before the work inside it ran. The statements are
 * issued by hand instead, and the driver's own `inTransaction` flag picks which
 * — the same branch better-sqlite3 takes. With nothing open: `begin`, then
 * `commit`, or `rollback` when `fn` throws. With a transaction already open —
 * another call to this helper, or one a module opened through
 * `database.transaction` — a `savepoint` … `release` pair, undone by
 * `rollback to` followed by its own `release`. A second `begin` would throw,
 * which is why the flag decides and not a private counter. When SQLite has
 * already aborted the transaction itself the undo is skipped: it would throw
 * over the caller's error.
 *
 * **The callback must be the only database-touching async chain in flight —
 * no `Promise.all` sibling, no lock hand-off, no fire-and-forget promise
 * started before it — and inside it, only await operations that resolve
 * without I/O: store methods, synchronous database writes.** Even a resolved
 * promise yields to the microtask queue first, so a sibling chain already
 * queued in the same macrotask still runs inside this open transaction; a
 * chain started in a separate macrotask is unaffected. Awaiting anything that
 * truly suspends — a timer, the filesystem, the network — hands the
 * connection to whatever runs next, and its writes land in this transaction
 * too.
 */
export async function runSqliteTransaction<T>(
  database: SqliteDatabase,
  fn: () => Promise<T>,
  options?: { mode?: SqliteTransactionMode },
): Promise<T> {
  const connection = readSqliteConnection(database)
  const scope = readTransactionScope(connection, options?.mode ?? 'deferred')

  database.run(sql.raw(scope.begin))
  try {
    const result = await fn()
    database.run(sql.raw(scope.commit))
    return result
  }
  catch (error) {
    if (connection.inTransaction) {
      database.run(sql.raw(scope.undo))
      if (scope.releaseAfterUndo) {
        database.run(sql.raw(scope.releaseAfterUndo))
      }
    }
    throw error
  }
}

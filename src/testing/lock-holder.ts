import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'

/**
 * How long the other writer keeps the board file's write lock, and how much of
 * that the waiting write must be seen to spend. The margin is what the hop
 * carrying the worker's "locked" message may cost: the lock is already taken
 * when the message is sent. A write that does not wait comes back in
 * single-digit milliseconds.
 */
export const LOCK_HOLD_MS = 300
export const LOCK_WAIT_MARGIN_MS = 150

/**
 * Another writer holding the board file's write lock, having written
 * `statements` under it, for `LOCK_HOLD_MS`, then committing.
 *
 * It runs off this thread because better-sqlite3 is synchronous: a connection
 * waiting for a lock blocks the thread it runs on, so a lock held by that same
 * thread could never be released while the wait goes on. In use the other
 * writer is another process — an app beside the command line — and SQLite locks
 * the file, not the connection that asked.
 */
const LOCK_HOLDER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
const Database = require(workerData.betterSqlitePath)

const connection = new Database(workerData.databasePath)
connection.pragma('busy_timeout = 5000')
connection.exec('begin immediate')
for (const statement of workerData.statements) {
  connection.exec(statement)
}
parentPort.postMessage('locked')
setTimeout(() => {
  connection.exec('commit')
  connection.close()
  parentPort.postMessage('released')
}, workerData.holdMs)
`

export interface LockHolder {
  /** Resolves once the lock is taken and the statements written, rejects if the worker fails before that. */
  locked: Promise<void>
  /** Throw whatever the worker failed with, at any point in its life. */
  assertHealthy: () => Promise<void>
  stop: () => Promise<void>
}

export function startLockHolder(databasePath: string, statements: readonly string[] = []): LockHolder {
  const worker = new Worker(LOCK_HOLDER_SOURCE, {
    eval: true,
    workerData: {
      databasePath,
      betterSqlitePath: createRequire(import.meta.url).resolve('better-sqlite3'),
      holdMs: LOCK_HOLD_MS,
      statements: [...statements],
    },
  })

  let failure: Error | null = null
  worker.on('error', (error: Error) => {
    failure = error
  })

  return {
    locked: new Promise<void>((resolve, reject) => {
      worker.once('message', () => resolve())
      worker.once('error', reject)
    }),
    // A commit that fails happens while this thread is blocked inside SQLite,
    // so its event can only arrive once the blocked write has returned.
    assertHealthy: async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
      if (failure) {
        throw failure
      }
    },
    stop: async () => {
      await worker.terminate()
    },
  }
}

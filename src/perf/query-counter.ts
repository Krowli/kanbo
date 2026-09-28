import type { Logger } from 'drizzle-orm'

/**
 * How many statements a board ran — the instrument the query-count tests and
 * `scripts/bench.mjs` read, and nothing a board in use ever pays for.
 *
 * It sits where every statement of both stores passes: the drizzle handle.
 * Drizzle hands each statement it executes to the handle's logger, and a
 * handle opened with none gets drizzle's no-op logger — so a board opened
 * while no count is on runs exactly as it did before this module existed.
 * Internal: not exported from any public entry of the package.
 */
export interface QueryCounter extends Logger {
  /** Statements run since the counter was made or last reset. */
  readonly count: number
  /** Their SQL, in order — what a failing count prints to show which statement repeats. */
  readonly statements: readonly string[]
  reset: () => void
}

export function createQueryCounter(): QueryCounter {
  let statements: string[] = []
  return {
    get count() {
      return statements.length
    },
    get statements() {
      return statements
    },
    reset: () => {
      statements = []
    },
    logQuery: (query: string) => {
      statements.push(query)
    },
  }
}

let counterForNewHandles: QueryCounter | null = null

/**
 * Count the statements of every board handle opened from now on — the board
 * file a command opens (`openBoardDatabase`) and the external board it
 * connects to — until called again with `null`. A handle already open keeps
 * whatever logger it was opened with.
 */
export function countQueriesOfNewBoardHandles(counter: QueryCounter | null): void {
  counterForNewHandles = counter
}

/** The logger a board handle is opened with: the counter while one is on, otherwise none. */
export function boardQueryLogger(): Logger | undefined {
  return counterForNewHandles ?? undefined
}

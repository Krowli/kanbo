import { maskDatabaseUrls } from '../domain/database-url'
import type { ColumnRefusalDetails } from '../domain/entry-rules'
import { describeColumnRefusal } from '../domain/entry-rules'
import { BoardError } from '../domain/errors'
import { CliError } from './output'

/**
 * What a failed command says, and what it leaves with.
 *
 * One place, because a failure is output as much as a result is: the exit code
 * a caller may branch on, the sentence a person reads, and the chain underneath
 * it that says what actually went wrong.
 */

/** How far down a chain of causes is still worth reading. */
const CAUSE_DEPTH_LIMIT = 5

/**
 * What to say about a failure, and what to leave with.
 *
 * A `CliError` already carries both. A `BoardError` is a rule of the board the
 * caller broke: its code is the honest name of what happened, and its details
 * say which value did it, so both are printed rather than translated into a
 * sentence that could drift away from the rule. The one exception is a card
 * held at a column's door: its details are a list, and a person reads it as
 * one line per rule the card does not meet yet (`describeColumnRefusal`).
 *
 * Whatever it is, its causes are printed under it. A driver's failure arrives
 * wrapped — `Failed query: create schema …` with the connection refused
 * underneath — and the wrapper alone tells a person nothing they can act on.
 * Every line goes through the masking on its way out, because a message this
 * tool did not write is free to carry the whole connection string in it.
 */
export function describeFailure(error: unknown): { message: string, exitCode: number } {
  const { message, exitCode } = readFailure(error)
  const causes = describeCauses(error, 1)
  return { message: maskDatabaseUrls([message, ...causes].join('\n')), exitCode }
}

function readFailure(error: unknown): { message: string, exitCode: number } {
  if (error instanceof CliError) {
    return { message: error.message, exitCode: error.exitCode }
  }
  if (error instanceof BoardError && error.code === 'board_column_rules_unmet') {
    return { message: describeColumnRefusal(error.details as unknown as ColumnRefusalDetails), exitCode: 1 }
  }
  if (error instanceof BoardError) {
    const details = error.details ? ` ${JSON.stringify(error.details)}` : ''
    return { message: `${error.code}${details}`, exitCode: 1 }
  }
  return { message: error instanceof Error ? error.message : String(error), exitCode: 1 }
}

/**
 * The chain under a failure, one indented line per link.
 *
 * Bounded, because `cause` is an ordinary property and nothing stops it
 * pointing back at the error it came from; a chain longer than this has stopped
 * explaining anything anyway.
 */
function describeCauses(error: unknown, depth: number): string[] {
  const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined
  if (cause === undefined || cause === null || depth > CAUSE_DEPTH_LIMIT) {
    return []
  }
  const message = cause instanceof Error ? cause.message : String(cause)
  return [`${'  '.repeat(depth)}Caused by: ${message}`, ...describeCauses(cause, depth + 1)]
}

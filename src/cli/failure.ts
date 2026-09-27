import pc from 'picocolors'

import { maskDatabaseUrls } from '../domain/database-url'
import { BoardError } from '../domain/errors'
import { humanizeBoardError } from './humanize'
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

/** What a failed command prints and leaves with; `code` is the board's name for it, when it has one. */
export interface DescribedFailure {
  message: string
  exitCode: number
  code?: string
}

/**
 * What to say about a failure, and what to leave with.
 *
 * A `CliError` already carries both. A `BoardError` is a rule of the board the
 * caller broke: a person reads it as a sentence and the command that gets them
 * further (`humanize.ts`), with the code in brackets behind it — the honest
 * name of what happened, for a search or a script:
 *
 *     No column "foo" on this board.
 *       Next: kanbo columns list  [issue_status_not_found]
 *
 * The values that caused it (`details`) are printed only with `KANBO_DEBUG=1`;
 * a code the table does not know yet falls back to the code and its details.
 *
 * Whatever it is, its causes are printed under it. A driver's failure arrives
 * wrapped — `Failed query: create schema …` with the connection refused
 * underneath — and the wrapper alone tells a person nothing they can act on.
 * Every line goes through the masking on its way out, because a message this
 * tool did not write is free to carry the whole connection string in it.
 */
export function describeFailure(error: unknown): DescribedFailure {
  const { message, exitCode, code } = readFailure(error)
  const causes = describeCauses(error, 1)
  const described: DescribedFailure = { message: maskDatabaseUrls([message, ...causes].join('\n')), exitCode }
  return code === undefined ? described : { ...described, code }
}

/** The failure as a terminal shows it: red, with the code in brackets dimmed. */
export function paintFailure(failure: DescribedFailure): string {
  if (failure.code === undefined) {
    return pc.red(failure.message)
  }
  const bracketed = `[${failure.code}]`
  return pc.red(failure.message.replace(bracketed, pc.dim(bracketed)))
}

function readFailure(error: unknown): DescribedFailure {
  if (error instanceof CliError) {
    return { message: error.message, exitCode: error.exitCode }
  }
  if (error instanceof BoardError) {
    return { message: describeBoardError(error), exitCode: 1, code: error.code }
  }
  return { message: error instanceof Error ? error.message : String(error), exitCode: 1 }
}

function describeBoardError(error: BoardError): string {
  const details = error.details ? JSON.stringify(error.details) : null
  const humanized = humanizeBoardError(error.code, error.details)
  if (!humanized) {
    return details ? `${error.code} ${details}` : error.code
  }
  const lines = humanized.next === undefined
    ? [`${humanized.text}  [${error.code}]`]
    : [humanized.text, `  Next: ${humanized.next}  [${error.code}]`]
  if (details && isDebugging()) {
    lines.push(`  Details: ${details}`)
  }
  return lines.join('\n')
}

function isDebugging(): boolean {
  const value = process.env.KANBO_DEBUG?.trim()
  return value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false'
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

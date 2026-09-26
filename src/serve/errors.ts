import type { ZodError } from 'zod'

import { CliError, EXIT_SCHEMA_OUTDATED } from '../cli/output'
import { BoardError } from '../domain/errors'
import { BOARD_ERROR_RESPONSES } from './board-error-responses'

/**
 * What a failed request answers with.
 *
 * The body is `{ code, message, details? }`, and a board failure goes through
 * `BOARD_ERROR_RESPONSES`, the one table every server of the `/issues` routes
 * answers with, so a client matching on a code or a status reads them alike.
 */

/** The JSON body of every failure. */
export interface ServeErrorBody {
  code: string
  message: string
  details?: Record<string, unknown>
}

/** A failure the HTTP edge names itself — a request it cannot route, read or let in. */
export class ServeError extends Error {
  readonly status: number
  readonly code: string
  readonly details?: Record<string, unknown>

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

/** Where an invalid value was found. */
export type ValidationSource = 'body' | 'query' | 'params'

/**
 * A request whose body, query or path did not have the shape the route takes:
 * 400 `validation_error`, with one `{ path, message }` per problem.
 */
export function validationError(source: ValidationSource, error: ZodError): ServeError {
  return new ServeError(400, 'validation_error', 'request validation failed', {
    source,
    issues: error.issues.map(issue => ({
      path: issue.path.length > 0 ? issue.path.map(String).join('.') : 'root',
      message: issue.message,
    })),
  })
}

/**
 * The status and body a failure answers with, or `null` for a failure nobody
 * named — a driver error, a bug — which the server answers as a 500 and says
 * nothing more about to the client.
 *
 * The schema guard is the command line's (`assertWritableBoard`), and it
 * refuses with a `CliError` a terminal prints; over HTTP it is the board's own
 * `board_schema_outdated`.
 */
export function readErrorResponse(error: unknown): { status: number, body: ServeErrorBody } | null {
  if (error instanceof ServeError) {
    return { status: error.status, body: withDetails({ code: error.code, message: error.message }, error.details) }
  }
  if (error instanceof CliError && error.exitCode === EXIT_SCHEMA_OUTDATED) {
    return readErrorResponse(new BoardError('board_schema_outdated'))
  }
  if (error instanceof BoardError) {
    const response = BOARD_ERROR_RESPONSES[error.code]
    return {
      status: response.status,
      body: withDetails({ code: response.code ?? error.code, message: response.message }, error.details),
    }
  }
  return null
}

function withDetails(body: ServeErrorBody, details: Record<string, unknown> | undefined): ServeErrorBody {
  return details === undefined ? body : { ...body, details }
}

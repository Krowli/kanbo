import './check-node'

import pc from 'picocolors'

import { describeFailure } from './failure'
import { runKanbo } from './program'

/**
 * `kanbo` — the board, from a terminal.
 *
 * It needs no server: it opens the board — a board file, a host app's database
 * the board lives in, or the external Postgres a project is bound to — and
 * calls the same board operations every other client does, so a card moved
 * here and a card moved on the board page tell the same story. What it never does is invent semantics of its own: every
 * command is a thin translation of arguments into one board operation.
 */
runKanbo(process.argv.slice(2)).catch((error: unknown) => {
  const failure = describeFailure(error)
  console.error(pc.red(failure.message))
  process.exit(failure.exitCode)
})

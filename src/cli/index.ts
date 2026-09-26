import { Command } from 'commander'
import pc from 'picocolors'

import { KANBO_PACKAGE_VERSION } from '../package-version'
import { registerKanboCommands } from './commands'
import { describeFailure } from './failure'

/**
 * `kanbo` — the board, from a terminal.
 *
 * It needs no server: it opens the board — a board file, a host app's database
 * the board lives in, or the external Postgres a project is bound to — and
 * calls the same board operations every other client does, so a card moved
 * here and a card moved on the board page tell the same story. What it never does is invent semantics of its own: every
 * command below is a thin translation of arguments into one board operation.
 */
async function main(): Promise<void> {
  const program = new Command()
    .name('kanbo')
    .description('A board for people and their agents, from a terminal. Reads and writes the board directly; no server needed.')
    .version(KANBO_PACKAGE_VERSION)

  registerKanboCommands(program)

  await program.parseAsync(process.argv)
}

main().catch((error: unknown) => {
  const failure = describeFailure(error)
  console.error(pc.red(failure.message))
  process.exit(failure.exitCode)
})

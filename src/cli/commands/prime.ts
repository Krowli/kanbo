import type { Command } from 'commander'

import type { BoardCommandOptions } from '../command'
import { runBoardCommand, withBoardOptions } from '../command'
import { COMMAND_SHEET } from '../setup/instructions'

/**
 * `kanbo prime` — what the board tells an agent about itself.
 *
 * The first thing an agent should run, and the reason the instruction block
 * `kanbo init` writes says so: the columns of this board with their meaning,
 * and the rules a card travels by. The text belongs to the board, not to this
 * tool, so the command prints what `buildPrimeText` says — and then the
 * commands, because an agent reading this from a shell may have no MCP tools
 * and nothing else to learn them from. The `kanbo_prime` tool leaves them out.
 */
export function registerPrimeCommand(program: Command): void {
  withBoardOptions(program
    .command('prime')
    .description('print the columns of this board and the rules a card travels by'))
    .action(async (options: BoardCommandOptions) => {
      await runBoardCommand(options, 'read', async (session) => {
        const text = `${await session.ops.buildPrimeText(session.workspace.id)}\n\n${COMMAND_SHEET}`
        return { value: { text }, text }
      })
    })
}

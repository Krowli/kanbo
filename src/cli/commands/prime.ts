import type { Command } from 'commander'

import type { BoardCommandOptions } from '../command'
import { runBoardCommand, withBoardOptions } from '../command'

/**
 * `kanbo prime` — what the board tells an agent about itself.
 *
 * The first thing an agent should run, and the reason the instruction block
 * `kanbo init` writes says so: the columns of this board with their meaning,
 * and the rules a card travels by. The text belongs to the board, not to this
 * tool, so the command only prints what `buildPrimeText` says.
 */
export function registerPrimeCommand(program: Command): void {
  withBoardOptions(program
    .command('prime')
    .description('print the columns of this board and the rules a card travels by'))
    .action(async (options: BoardCommandOptions) => {
      await runBoardCommand(options, 'read', async (session) => {
        const text = await session.ops.buildPrimeText(session.workspace.id)
        return { value: { text }, text }
      })
    })
}

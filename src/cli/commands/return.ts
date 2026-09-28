import type { Command } from 'commander'

import { requireHumanActor, typedCommand } from '../actor'
import type { BoardCommandOptions } from '../command'
import { requireCard, runBoardCommand, withBoardOptions } from '../command'
import { describeCard, projectCard } from '../view'

interface ReturnOptions extends BoardCommandOptions {
  comment: string
  to?: string
}

/**
 * `kanbo return` — a person sending a card back with a reason.
 *
 * The reason is required because it is the point: it goes on the card as the
 * person's comment and as the status line, so the next agent to pick the card
 * up reads why it came back before anything else. Whatever was running on the
 * card is stopped in the same write, by the board.
 *
 * Nothing else happens here. A chat session parked on this card is woken by
 * the server, which is watching the board — the terminal does not have to know
 * that anything is waiting.
 */
export function registerReturnCommand(program: Command): void {
  withBoardOptions(program
    .command('return')
    .description('Send a card back to the previous column, saying why')
    .argument('<card>', 'the card, as MAN-012, MAN-12 or 12')
    .requiredOption('--comment <text>', 'why the card is coming back')
    .option('--to <column>', 'send it to this column instead, by slug, name or id'))
    .action(async (reference: string, options: ReturnOptions, command: Command) => {
      const actor = requireHumanActor('return', typedCommand(command))

      await runBoardCommand(options, 'write', async (session) => {
        const existing = await requireCard(session, reference)
        const { card, stoppedRunIds } = await session.ops.returnCard(existing.id, {
          comment: options.comment,
          toStatusName: options.to,
        }, actor)

        const [columns, runs] = await Promise.all([
          session.ops.listColumns(session.workspace.id),
          session.ops.readBoardProjectionForIssue(card.id),
        ])
        const view = projectCard(card, columns, runs)
        const stopped = stoppedRunIds.length > 0 ? `\nStopped ${stoppedRunIds.length} run(s)` : ''
        return {
          value: { card: view, stoppedRunIds },
          text: `Returned ${view.id} to ${view.column ?? '—'}${stopped}\n\n${describeCard(view)}`,
        }
      })
    })
}

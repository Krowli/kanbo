import type { Command } from 'commander'

import { requireHumanActor } from '../actor'
import type { BoardCommandOptions } from '../command'
import { requireCard, runBoardCommand, withBoardOptions } from '../command'
import { CARD_VIEW_FIELDS, describeCard, projectCard } from '../view'

interface ApproveOptions extends BoardCommandOptions {
  comment?: string
}

/**
 * `kanbo approve` — a person accepting the work on a card.
 *
 * The shell is checked before the board is even opened: a refusal has to leave
 * the database exactly as it found it, and the check costs nothing. The board
 * refuses a non-person actor of its own accord too — this is the same rule said
 * earlier, with a message a person can act on.
 */
export function registerApproveCommand(program: Command): void {
  withBoardOptions(program
    .command('approve')
    .description('Approve the work on a card that is waiting for you')
    .argument('<card>', 'the card, as MAN-012, MAN-12 or 12')
    .option('--comment <text>', 'a note to leave on the card'))
    .action(async (reference: string, options: ApproveOptions) => {
      const actor = requireHumanActor('approve')

      await runBoardCommand(options, 'write', async (session) => {
        const existing = await requireCard(session, reference)
        const approved = await session.ops.approve(existing.id, { comment: options.comment }, actor)
        const [columns, runs] = await Promise.all([
          session.ops.listColumns(session.workspace.id),
          session.ops.readBoardProjectionForIssue(approved.id),
        ])
        const view = projectCard(approved, columns, runs)
        return { value: view, text: `Approved ${view.id}\n\n${describeCard(view)}`, fields: CARD_VIEW_FIELDS }
      })
    })
}

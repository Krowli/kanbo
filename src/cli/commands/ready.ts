import type { Command } from 'commander'

import type { BoardCommandOptions } from '../command'
import { parseCount, runBoardCommand, withBoardOptions } from '../command'
import { CARD_VIEW_FIELDS, describeCards, projectCard } from '../view'

interface ReadyOptions extends BoardCommandOptions {
  limit?: number
}

/**
 * `kanbo ready` — the cards an agent may pick up right now.
 *
 * What counts as ready is the board's rule, not this tool's: spelled out,
 * nobody working on it, nobody's turn but the agent's. An agent asking for work
 * takes the first line and starts there.
 */
export function registerReadyCommand(program: Command): void {
  withBoardOptions(program
    .command('ready')
    .description('cards that are spelled out, unclaimed and nobody else\'s turn')
    .option('--limit <count>', 'how many cards to print', parseCount))
    .action(async (options: ReadyOptions) => {
      await runBoardCommand(options, 'read', async (session) => {
        const columns = await session.ops.listColumns(session.workspace.id)
        const rows = await session.ops.listReady({ workspaceId: session.workspace.id, limit: options.limit })
        const runs = await session.ops.readBoardProjectionForIssues(rows.map(card => card.id))
        const cards = rows.map((card, index) => projectCard(card, columns, runs[index]))
        return { value: cards, text: describeCards(cards), fields: CARD_VIEW_FIELDS }
      })
    })
}

import type { Command } from 'commander'

import type { BoardCommandOptions } from '../command'
import { parseCount, runBoardCommand, withBoardOptions } from '../command'
import { CARD_VIEW_FIELDS, describeCards, projectCard } from '../view'

interface ReadyOptions extends BoardCommandOptions {
  limit?: number
  all?: boolean
}

/** How many cards `kanbo ready` prints when the caller names no limit. */
const DEFAULT_READY_LIMIT = 10

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
    .description('Cards ready to start: in To Do, not taken, not waiting for a person')
    .option('--limit <count>', `how many cards to print (${DEFAULT_READY_LIMIT} when left out)`, parseCount)
    .option('--all', 'print every ready card'))
    .action(async (options: ReadyOptions) => {
      await runBoardCommand(options, 'read', async (session) => {
        const page = await session.ops.queryReady({
          workspaceId: session.workspace.id,
          limit: options.all ? undefined : options.limit ?? DEFAULT_READY_LIMIT,
        })
        const runs = await session.ops.readBoardProjectionForIssues(page.cards.map(card => card.id))
        const cards = page.cards.map((card, index) => projectCard(card, page.columns, runs[index]))
        if (page.total > cards.length) {
          console.error(`kanbo: ${page.total - cards.length} more ready; --limit <count> or --all for more`)
        }
        return { value: cards, text: describeCards(cards), fields: CARD_VIEW_FIELDS }
      })
    })
}

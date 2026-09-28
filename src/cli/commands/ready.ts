import type { Command } from 'commander'

import type { CardQueryResult } from '../../ops/card-query'
import type { BoardCommandOptions, BoardSession } from '../command'
import { parseCount, runBoardCommand, withBoardOptions } from '../command'
import type { CardView } from '../view'
import { CARD_VIEW_FIELDS, describeCards, projectCard, withCardAttention } from '../view'

interface ReadyOptions extends BoardCommandOptions {
  limit?: number
  all?: boolean
}

/** How many cards `kanbo ready` prints when the caller names no limit. */
const DEFAULT_READY_LIMIT = 10

/** How many returned cards `kanbo ready` prints ahead of the ready ones, at most. */
const READY_RETURNED_LIMIT = 5

/**
 * The ready cards, and ahead of them the cards a person sent back — an agent
 * continues those before it takes anything new. `--json` stays the ready
 * cards alone; `kanbo card list --returned --json` lists the others.
 */
async function describeReady(session: BoardSession, cards: CardView[], returned: CardQueryResult): Promise<string> {
  if (returned.cards.length === 0) {
    return describeCards(cards)
  }
  const runs = await session.ops.readBoardProjectionForIssues(returned.cards.map(card => card.id))
  const attention = await session.ops.readCardAttention(returned.cards, runs.map(() => false))
  const views = withCardAttention(returned.cards.map((card, index) => projectCard(card, returned.columns, runs[index])), attention)
  const more = returned.total - views.length
  return [
    'Returned to you — continue these first, then hand them back to a person:',
    describeCards(views),
    ...(more > 0 ? [`… and ${more} more: kanbo card list --returned`] : []),
    '',
    'Ready:',
    describeCards(cards),
  ].join('\n')
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
    .description('Cards ready to start: in To Do, not taken, not waiting for a person')
    .option('--limit <count>', `how many cards to print (${DEFAULT_READY_LIMIT} when left out)`, parseCount)
    .option('--all', 'print every ready card'))
    .action(async (options: ReadyOptions) => {
      await runBoardCommand(options, 'read', async (session) => {
        const page = await session.ops.queryReady({
          workspaceId: session.workspace.id,
          limit: options.all ? undefined : options.limit ?? DEFAULT_READY_LIMIT,
        })
        const [runs, returned] = await Promise.all([
          session.ops.readBoardProjectionForIssues(page.cards.map(card => card.id)),
          session.ops.queryCards({ workspaceId: session.workspace.id, returned: true, limit: READY_RETURNED_LIMIT }),
        ])
        // A ready card waits for no one, and one a person returned is listed above the ready ones.
        const cards = page.cards.map((card, index) => projectCard(card, page.columns, runs[index]))
        if (page.total > cards.length) {
          console.error(`kanbo: ${page.total - cards.length} more ready; --limit <count> or --all for more`)
        }
        return { value: cards, text: await describeReady(session, cards, returned), fields: CARD_VIEW_FIELDS }
      })
    })
}

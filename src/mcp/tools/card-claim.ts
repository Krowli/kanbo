import { z } from 'zod'

import { compactKanboCard } from '../card-output'
import { CARD_ALIASES, cardArgument, defineKanboTool } from './tool'

/**
 * Taking a card to work on, in one step: the run starts and the card moves out
 * of To Do into the board's first work-in-progress column in the same write,
 * so two agents never get the same card. Published to every host, including
 * one that records the runs of the agents it launches: a claim is how an agent
 * in any terminal takes work.
 */
export const cardClaimTool = defineKanboTool({
  name: 'kanbo_card_claim',
  title: 'Claim a card',
  description: 'Take a card to work on, in one step: it starts your run and moves the card from To Do into the board\'s first work-in-progress column. '
    + 'Without `card`, takes the first ready card. Two agents never get the same card: the one that loses is told board_nothing_ready or board_card_not_ready. '
    + 'Answers the card compact, the run id, the column, and the kanbo_run_finish call that ends the run.',
  inputSchema: {
    card: cardArgument.optional(),
    agent: z.string().min(1).optional().describe('What to call whoever works the card; who this server writes as when absent.'),
  },
  aliases: { card: [...CARD_ALIASES, 'issue'], agent: ['agentName'] },
  example: { card: 'TST-5' },
  run: async (transport, input) => {
    const claimed = await transport.cardClaim(input)
    return {
      card: compactKanboCard(claimed.card),
      run: claimed.run.id,
      column: claimed.column.slug,
      finishWith: `kanbo_run_finish {"run":"${claimed.run.id}","state":"finished"}`,
    }
  },
})

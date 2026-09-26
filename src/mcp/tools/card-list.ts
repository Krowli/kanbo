import { z } from 'zod'

import { defineKanboTool } from './tool'

/** The cards on the board, optionally only those in one column. */
export const cardListTool = defineKanboTool({
  name: 'kanbo_card_list',
  title: 'List cards',
  description: 'List the cards on this board in board order, optionally only the ones in one column.',
  inputSchema: {
    column: z.string().min(1).optional().describe('Only cards in this column, by its slug or name.'),
    limit: z.number().int().positive().optional().describe('How many cards to return. All of them when absent.'),
  },
  run: async (transport, input) => await transport.cardList(input),
})

import { z } from 'zod'

import { defineKanboTool } from './tool'

/** The cards an agent may pick up right now. */
export const readyTool = defineKanboTool({
  name: 'kanbo_ready',
  title: 'Cards ready to pick up',
  description: 'List the cards that are spelled out, that nobody is working on and that are waiting for no one, in board order.',
  inputSchema: {
    limit: z.number().int().positive().optional().describe('How many cards to return. All of them when absent.'),
  },
  run: async (transport, input) => await transport.ready(input),
})

import { z } from 'zod'

import { cardArgument, defineKanboTool } from './tool'

/** What the card is doing right now, which is what a person watching sees. */
export const statusLineTool = defineKanboTool({
  name: 'kanbo_status_line',
  title: 'Set the status line',
  description: 'Say what the card is doing right now. Write one at every step, including before and after anything long-running.',
  inputSchema: {
    card: cardArgument,
    text: z.string().min(1).describe('One sentence, present tense, about what is happening on the card right now.'),
  },
  run: async (transport, input) => await transport.statusLine(input),
})

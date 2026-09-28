import { z } from 'zod'

import { formatWrittenKanboCard, WRITTEN_CARD_ANSWER_SENTENCE, writtenCardDetailArgument } from '../card-output'
import { cardArgument, defineKanboTool } from './tool'

/** What the card is doing right now, which is what a person watching sees. */
export const statusLineTool = defineKanboTool({
  name: 'kanbo_status_line',
  title: 'Set the status line',
  description: 'Say what the card is doing right now: `card` and `text` (one sentence). Write one at every step, including before and after anything long-running. '
    + WRITTEN_CARD_ANSWER_SENTENCE,
  inputSchema: {
    card: cardArgument,
    text: z.string().min(1).describe('One sentence, present tense, about what is happening on the card right now. Also accepted as `content`.'),
    detail: writtenCardDetailArgument,
  },
  aliases: { text: ['content'] },
  needs: { text: 'the status line, one sentence' },
  example: { card: 'TST-5', text: 'Running the tests' },
  run: async (transport, { detail, ...input }) => formatWrittenKanboCard(await transport.statusLine(input), detail),
})

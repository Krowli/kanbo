import { z } from 'zod'

import { formatWrittenKanboCard, WRITTEN_CARD_ANSWER_SENTENCE, writtenCardDetailArgument } from '../card-output'
import { cardArgument, defineKanboTool } from './tool'

/**
 * The end of a turn that needs a person.
 *
 * There is no tool that approves. A person approves on the board, and the card
 * stays waiting until they do — an agent that could take its own card out of
 * waiting would make every card waiting for a person a lie.
 */
export const waitApprovalTool = defineKanboTool({
  name: 'kanbo_wait_approval',
  title: 'Hand the card to a person',
  description: 'Mark the card as waiting for a person and end your turn: `card`, and `text` for the status line the person reads. '
    + `A person approves or returns it; you will be told the answer. ${WRITTEN_CARD_ANSWER_SENTENCE}`,
  inputSchema: {
    card: cardArgument,
    text: z.string().min(1).optional().describe('The status line to leave, saying what the person is being asked to look at. Also accepted as `content`.'),
    detail: writtenCardDetailArgument,
  },
  aliases: { text: ['content'] },
  example: { card: 'TST-5', text: 'Ready for review: slugify added with a test' },
  run: async (transport, { detail, ...input }) => formatWrittenKanboCard(await transport.waitApproval(input), detail),
})

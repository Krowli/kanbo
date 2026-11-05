import { z } from 'zod'

import { formatWrittenKanboCard, WRITTEN_CARD_ANSWER_SENTENCE, writtenCardDetailArgument } from '../card-output'
import { cardArgument, defineKanboTool } from './tool'

/** Moving a card, which is how the board tells the truth about it. */
export const cardMoveTool = defineKanboTool({
  name: 'kanbo_card_move',
  title: 'Move a card',
  description: 'Move a card to another column the moment its real state changes. Read kanbo_columns first: a card in the wrong column is a lie, '
    + `and a column refuses a card that does not meet its entryRules yet, that comes from a column it does not accept (allowedFrom), or that would overfill it (wipLimit), listing what is missing. ${WRITTEN_CARD_ANSWER_SENTENCE}`,
  inputSchema: {
    card: cardArgument,
    column: z.string().min(1).describe('The column to move it to, by its slug or name: in_progress, "In Progress". Also accepted as `to`.'),
    detail: writtenCardDetailArgument,
  },
  aliases: { column: ['to'] },
  needs: { column: 'the column slug, e.g. in_progress' },
  example: { card: 'TST-5', column: 'in_progress' },
  run: async (transport, { detail, ...input }) => formatWrittenKanboCard(await transport.cardMove(input), detail),
})

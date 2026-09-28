import { z } from 'zod'

import { cardArgument, defineKanboTool } from './tool'

/** Anything a person has to read, written where they will find it. */
export const cardCommentTool = defineKanboTool({
  name: 'kanbo_card_comment',
  title: 'Comment on a card',
  description: 'Write a finding, a decision or an open question on the card, where a person reads it: `card` and `content` (the comment text). '
    + 'Your transcript is not the card.',
  inputSchema: {
    card: cardArgument,
    content: z.string().min(1).describe('The comment text: what to say, written for whoever opens this card next. Also accepted as `text`.'),
  },
  aliases: { content: ['text'] },
  needs: { content: 'the comment text' },
  example: { card: 'TST-5', content: 'Added slugify(text) and a test; npm test passes.' },
  run: async (transport, input) => await transport.cardComment(input),
})

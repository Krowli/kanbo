import { z } from 'zod'

import { formatWrittenKanboCard, WRITTEN_CARD_ANSWER_SENTENCE, writtenCardDetailArgument } from '../card-output'
import { cardArgument, defineKanboTool, executionModeArgument } from './tool'

/** What a card says: its title, what it is about, how urgent it is, how it is labelled. */
export const cardUpdateTool = defineKanboTool({
  name: 'kanbo_card_update',
  title: 'Update a card',
  description: `Change what a card says: its title, its description, its priority, its labels or where its work happens. ${WRITTEN_CARD_ANSWER_SENTENCE}`,
  inputSchema: {
    card: cardArgument,
    title: z.string().min(1).optional().describe('What the card is called.'),
    description: z.string().optional().describe('What the card is about. Replaces the description it has.'),
    priority: z.enum(['none', 'low', 'medium', 'high', 'urgent']).optional(),
    labels: z.array(z.string()).optional().describe('The labels the card carries, replacing the ones it has.'),
    executionMode: executionModeArgument.optional(),
    detail: writtenCardDetailArgument,
  },
  example: { card: 'TST-5', title: 'Add slugify' },
  run: async (transport, { card, detail, ...patch }) => {
    // An update that names no field still writes: the board version goes up and
    // every reader is told the board changed when nothing did.
    if (Object.keys(patch).length === 0) {
      throw new Error('Nothing to update. Pass title, description, priority, labels or executionMode.')
    }
    return formatWrittenKanboCard(await transport.cardUpdate({ card, ...patch }), detail)
  },
})

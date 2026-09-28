import { z } from 'zod'

import { formatWrittenKanboCard, WRITTEN_CARD_ANSWER_SENTENCE, writtenCardDetailArgument } from '../card-output'
import { cardArgument, defineKanboTool, executionModeArgument } from './tool'

/** What a card says — its title, what it is about, how urgent it is, how it is labelled — and which card it sits under. */
export const cardUpdateTool = defineKanboTool({
  name: 'kanbo_card_update',
  title: 'Update a card',
  description: 'Change what a card says: its title, its description, its priority, its labels or where its work happens. '
    + `A card at the wrong level moves with \`parent\`: another card's id, or "none" for the top level. ${WRITTEN_CARD_ANSWER_SENTENCE}`,
  inputSchema: {
    card: cardArgument,
    title: z.string().min(1).optional().describe('What the card is called.'),
    description: z.string().optional().describe('What the card is about. Replaces the description it has.'),
    priority: z.enum(['none', 'low', 'medium', 'high', 'urgent']).optional(),
    labels: z.array(z.string()).optional().describe('The labels the card carries, replacing the ones it has.'),
    executionMode: executionModeArgument.optional(),
    parent: cardArgument.optional().describe('The card to put this one under, by its id or key, e.g. MAN-012; "none" makes it a top-level card.'),
    detail: writtenCardDetailArgument,
  },
  example: { card: 'TST-5', title: 'Add slugify' },
  // Models send null for the fields they are not changing. Read as "none", a
  // null would take the card out from under its parent without anyone asking;
  // it is read as not given instead.
  prepare: (input) => {
    const { parent, ...rest } = input
    return parent === null ? rest : input
  },
  run: async (transport, { card, detail, parent, ...patch }) => {
    // An update that names no field still writes: the board version goes up and
    // every reader is told the board changed when nothing did.
    if (Object.keys(patch).length === 0 && parent === undefined) {
      throw new Error('Nothing to update. Pass title, description, priority, labels, executionMode or parent.')
    }
    const placement = parent === undefined ? {} : { parent: parent === 'none' ? null : parent }
    return formatWrittenKanboCard(await transport.cardUpdate({ card, ...patch, ...placement }), detail)
  },
})

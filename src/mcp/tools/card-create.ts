import { z } from 'zod'

import { cardArgument, defineKanboTool, executionModeArgument } from './tool'

/** What an agent is told about subtasks, word for word in the tool and in its `parent` field. */
const SUBTASK_SENTENCE = 'To create a subtask (sub-card) under another card, pass `parent` = that card\'s id (its key, e.g. `MAN-012`).'

/** A new card, or a sub-card of the one being worked on. */
export const cardCreateTool = defineKanboTool({
  name: 'kanbo_card_create',
  title: 'Create a card',
  description: `Put a new card on this board. ${SUBTASK_SENTENCE} Create subtasks only when the person asks for them, or when a task has parts that can be done and checked separately (different stages, owners or pull requests); do not split small work you will finish in one go. When you do split a card, make the parts subtasks of it (pass \`parent\`), not separate top-level cards.`,
  inputSchema: {
    title: z.string().optional().describe('What the card is called. Leave it out and the card is titled with its own key; the description then says what the task is.'),
    description: z.string().optional().describe('What the card is about, spelled out for whoever picks it up.'),
    column: z.string().min(1).optional().describe('The column to open it in, by slug or name. The board\'s first column when absent.'),
    parent: cardArgument.optional().describe(SUBTASK_SENTENCE),
    executionMode: executionModeArgument.optional(),
  },
  run: async (transport, input) => await transport.cardCreate(input),
})

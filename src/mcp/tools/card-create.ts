import { z } from 'zod'

import { SUBTASK_WHEN_SENTENCE, subtaskSplitSentence } from '../../ops/agent-rules'
import { formatWrittenKanboCard, WRITTEN_CARD_ANSWER_SENTENCE, writtenCardDetailArgument } from '../card-output'
import { cardArgument, defineKanboTool, executionModeArgument } from './tool'

/** What an agent is told about subtasks, word for word in the tool and in its `parent` field. */
const SUBTASK_SENTENCE = 'To create a subtask (sub-card) under another card, pass `parent` = that card\'s id (its key, e.g. `MAN-012`).'

/** A new card, or a sub-card of the one being worked on. */
export const cardCreateTool = defineKanboTool({
  name: 'kanbo_card_create',
  title: 'Create a card',
  description: `Put a new card on this board. ${SUBTASK_SENTENCE} ${SUBTASK_WHEN_SENTENCE} ${subtaskSplitSentence('pass `parent`')} `
    + WRITTEN_CARD_ANSWER_SENTENCE,
  inputSchema: {
    title: z.string().optional().describe('What the card is called. Leave it out and the card is titled with its own key; the description then says what the task is.'),
    description: z.string().optional().describe('What the card is about, spelled out for whoever picks it up.'),
    column: z.string().min(1).optional().describe('The column to open it in, by slug or name. The board\'s first column when absent.'),
    parent: cardArgument.optional().describe(SUBTASK_SENTENCE),
    executionMode: executionModeArgument.optional(),
    detail: writtenCardDetailArgument,
  },
  example: { description: 'Add slugify(text) with a test', parent: 'TST-1' },
  run: async (transport, { detail, ...input }) => formatWrittenKanboCard(await transport.cardCreate(input), detail),
})

import { z } from 'zod'

import { cardListViewArguments, formatKanboCardPage } from '../card-output'
import { defineKanboTool } from './tool'

/** How many cards `kanbo_ready` answers with when the caller names no limit. */
export const DEFAULT_READY_LIMIT = 10

/** How many returned cards `kanbo_ready` lists ahead of the ready ones, at most. */
export const READY_RETURNED_LIMIT = 5

/** The cards an agent may pick up right now. */
export const readyTool = defineKanboTool({
  name: 'kanbo_ready',
  title: 'Cards ready to pick up',
  description: 'The cards to take next: in To Do, nobody working on them, waiting for no one, in board order — take the first. '
    + `Answers ${DEFAULT_READY_LIMIT} compact cards with total; then read the one you take with kanbo_card_get. `
    + 'Cards a person sent back come first, under returned, each with the person\'s comment: continue those before anything new.',
  inputSchema: {
    limit: z.number().int().positive().optional().describe(`How many cards to return; ${DEFAULT_READY_LIMIT} when absent.`),
    offset: z.number().int().nonnegative().optional().describe('How many ready cards to skip: the nextOffset of the previous answer.'),
    ...cardListViewArguments,
  },
  run: async (transport, { limit, offset, detail, fields }) => {
    const page = await transport.readyPage({
      limit: limit ?? DEFAULT_READY_LIMIT,
      offset,
      // Only on the first page: a caller paging through the queue has seen them.
      returnedLimit: offset ? undefined : READY_RETURNED_LIMIT,
    })
    return formatKanboCardPage(page, { detail, fields }, page.returned)
  },
})

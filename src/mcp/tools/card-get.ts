import { z } from 'zod'

import { DEFAULT_KANBO_COMMENT_LIMIT, KANBO_CARD_INCLUDES } from '../transport'
import { cardArgument, defineKanboTool } from './tool'

/** One card in full, with what an agent reads next to it. */
export const cardGetTool = defineKanboTool({
  name: 'kanbo_card_get',
  title: 'Read a card',
  description: `Read one card in full — description, column, status line, whose turn it is, parent (\`parentIssueId\`) — `
    + `with its last ${DEFAULT_KANBO_COMMENT_LIMIT} comments and its subtasks (\`subCards\`), in one call. `
    + 'Its runs, field history and pull requests too: include: ["comments","subCards","runs","history","prs"].',
  inputSchema: {
    card: cardArgument,
    include: z.array(z.enum(KANBO_CARD_INCLUDES)).optional()
      .describe('What to read with the card; ["comments","subCards"] when absent, [] for the card alone.'),
    commentLimit: z.number().int().positive().optional()
      .describe(`How many of the latest comments to include; ${DEFAULT_KANBO_COMMENT_LIMIT} when absent.`),
  },
  example: { card: 'TST-5' },
  run: async (transport, input) => await transport.cardGet(input),
})

import { z } from 'zod'

import { readUnixSeconds } from '../../domain/time'
import { cardListViewArguments, formatKanboCardPage } from '../card-output'
import { defineKanboTool } from './tool'

/** How many cards `kanbo_card_list` answers with when the caller names no limit. */
export const DEFAULT_CARD_LIST_LIMIT = 50

const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const

/** The cards on the board a question picks, one page of them. */
export const cardListTool = defineKanboTool({
  name: 'kanbo_card_list',
  title: 'List cards',
  description: 'Find cards in one call; filters combine. Waiting for a person: waitingForPerson: true. '
    + 'Being worked on: hasActiveRun: true. Sub-cards: parent. Search: text. Changed since you last looked: updatedSince. '
    + `Answers ${DEFAULT_CARD_LIST_LIMIT} compact cards in board order with total and nextOffset; descriptions: fields: ["description"].`,
  inputSchema: {
    column: z.string().min(1).optional().describe('Only cards in this column, by its slug or name.'),
    columns: z.array(z.string().min(1)).optional().describe('Only cards in any of these columns.'),
    waitingForPerson: z.boolean().optional().describe('true: only cards waiting for a person; false: none of those.'),
    parent: z.string().min(1).optional().describe('Only the sub-cards of this card: its id (WOR-001), key without padding (WOR-1) or number (1).'),
    hasActiveRun: z.boolean().optional().describe('true: only cards an agent is working on now; false: only cards nobody is.'),
    text: z.string().min(1).optional().describe('Only cards whose id, title or description contains this, ignoring case.'),
    updatedSince: z.union([z.number().int().nonnegative(), z.string().min(1)]).optional()
      .describe('Only cards changed at or after this moment: unix seconds (not milliseconds), an ISO date-time with Z or an offset such as 2026-09-28T10:00:00Z, or a date such as 2026-09-28 (UTC midnight).'),
    labels: z.array(z.string().min(1)).optional().describe('Only cards carrying every one of these labels.'),
    priority: z.array(z.enum(PRIORITIES)).optional().describe('Only cards of any of these priorities.'),
    limit: z.number().int().positive().optional().describe(`How many cards to return; ${DEFAULT_CARD_LIST_LIMIT} when absent.`),
    offset: z.number().int().nonnegative().optional().describe('How many picked cards to skip: the nextOffset of the previous answer.'),
    ...cardListViewArguments,
  },
  run: async (transport, { column, columns, updatedSince, limit, detail, fields, ...filters }) => {
    const named = [...(column ? [column] : []), ...(columns ?? [])]
    const page = await transport.cardPage({
      ...filters,
      columns: named.length > 0 ? named : undefined,
      updatedSince: updatedSince === undefined ? undefined : readMoment(updatedSince),
      limit: limit ?? DEFAULT_CARD_LIST_LIMIT,
    })
    return formatKanboCardPage(page, { detail, fields })
  },
})

/** The moment `updatedSince` names, as unix seconds, or the error that says it names none. */
function readMoment(value: number | string): number {
  try {
    return readUnixSeconds(value)
  }
  catch (error) {
    throw new TypeError(`updatedSince: ${(error as Error).message}`)
  }
}

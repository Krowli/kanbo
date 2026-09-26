import { cardArgument, defineKanboTool } from './tool'

/** One card in full. */
export const cardGetTool = defineKanboTool({
  name: 'kanbo_card_get',
  title: 'Read a card',
  description: 'Read one card in full: what it is for, the column it sits in, what it is doing right now, who it is waiting for, its parent (`parentIssueId`) and its subtasks (`subCards`).',
  inputSchema: {
    card: cardArgument,
  },
  run: async (transport, input) => await transport.cardGet(input),
})

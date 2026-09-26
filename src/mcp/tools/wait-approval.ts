import { z } from 'zod'

import { cardArgument, defineKanboTool } from './tool'

/**
 * The end of a turn that needs a person.
 *
 * There is no tool that approves. A person approves on the board, and the card
 * stays waiting until they do — an agent that could take its own card out of
 * waiting would make every card waiting for a person a lie.
 */
export const waitApprovalTool = defineKanboTool({
  name: 'kanbo_wait_approval',
  title: 'Hand the card to a person',
  description: 'Mark the card as waiting for a person and end your turn. A person approves or returns it; you will be told the answer.',
  inputSchema: {
    card: cardArgument,
    text: z.string().min(1).optional().describe('The status line to leave, saying what the person is being asked to look at.'),
  },
  run: async (transport, input) => await transport.waitApproval(input),
})

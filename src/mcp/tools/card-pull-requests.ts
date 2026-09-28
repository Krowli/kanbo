import { cardArgument, defineKanboTool } from './tool'

/** The pull requests a card names. */
export const cardPullRequestsTool = defineKanboTool({
  name: 'kanbo_card_pull_requests',
  title: 'List a card\'s pull requests',
  description: 'The pull requests linked to the card, in the order they were linked.',
  inputSchema: {
    card: cardArgument,
  },
  example: { card: 'TST-5' },
  run: async (transport, input) => await transport.cardPullRequests(input),
})

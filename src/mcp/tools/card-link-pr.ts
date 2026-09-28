import { z } from 'zod'

import { cardArgument, defineKanboTool } from './tool'

/** A pull request the card's work went into, named on the card so its facts reach it. */
export const cardLinkPrTool = defineKanboTool({
  name: 'kanbo_card_link_pr',
  title: 'Link a pull request to a card',
  description: 'Opened a pull request for this card? Link it here. Its state and CI results then reach the card as comments, '
    + 'without you writing them. Linking the same pull request again changes nothing.',
  inputSchema: {
    card: cardArgument,
    url: z.string().min(1).describe('The pull request, as https://github.com/<owner>/<repo>/pull/<number> or <owner>/<repo>#<number>.'),
  },
  needs: { url: 'the pull request' },
  example: { card: 'TST-5', url: 'https://github.com/owner/repo/pull/12' },
  run: async (transport, input) => await transport.cardLinkPullRequest(input),
})

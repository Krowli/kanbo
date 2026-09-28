import { z } from 'zod'

import { cardArgument, defineKanboTool, executionModeArgument } from './tool'

/**
 * Saying a card is being worked on.
 *
 * Only an agent that launched itself needs this. An app that launches agents writes the run row
 * before the agent it launched starts, which is why this tool is not published
 * to one.
 */
export const runStartTool = defineKanboTool({
  name: 'kanbo_run_start',
  title: 'Start a run',
  description: 'Record that you have started working on a card, so nobody else picks it up while you are on it.',
  inputSchema: {
    card: cardArgument,
    agent: z.string().min(1).describe('What to call whoever is working on the card.'),
    branch: z.string().min(1).optional().describe('The branch the work happens on.'),
    executionMode: executionModeArgument.optional(),
    session: z.string().min(1).optional().describe('Your own log of this run: claude:<session id> or codex:<session id>. Leave it out — kanbo fills in the session Claude Code or Codex names in its environment, when it can read one. Never invent one.'),
  },
  aliases: { agent: ['agentName'] },
  needs: { agent: 'what to call you, e.g. claude' },
  example: { card: 'TST-5', agent: 'claude' },
  run: async (transport, input) => {
    const started = await transport.runStart(input)
    // The next call this run needs, spelled out: agents guessed the finish state before.
    return { ...started, finishWith: `kanbo_run_finish {"run":"${started.id}","state":"finished"}` }
  },
})

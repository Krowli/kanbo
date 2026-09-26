import { defineKanboTool } from './tool'

/** What the board tells an agent about itself, in the board's own words. */
export const primeTool = defineKanboTool({
  name: 'kanbo_prime',
  title: 'Read the board',
  description: 'Read what this board is: its columns, what each one means, and the rules a card travels by. Run this first.',
  inputSchema: {},
  run: async transport => (await transport.prime()).text,
})

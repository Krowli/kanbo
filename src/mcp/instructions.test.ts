import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'

import { AGENT_GUIDE_TEXT } from '../cli/setup/instructions'
import { BOARD_RULES, SUBTASK_RULE, WAIT_FOR_PERSON_RULE } from '../ops/agent-rules'
import { KANBO_MCP_INSTRUCTIONS } from './instructions'
import { createKanboMcpServer } from './server'
import type { KanboToolTransport } from './transport'

/** The instructions are sent before any board is resolved, so no tool is ever called here. */
const NO_TRANSPORT = {} as unknown as KanboToolTransport

async function initializeInstructions(): Promise<string | undefined> {
  const server = createKanboMcpServer(NO_TRANSPORT, { includeRunTools: true })
  const [clientChannel, serverChannel] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'instructions-test', version: '0.0.0' })
  await Promise.all([client.connect(clientChannel), server.connect(serverChannel)])
  const instructions = client.getInstructions()
  await client.close()
  return instructions
}

describe('the kanbo MCP server instructions', () => {
  it('reach a client in the initialize result', async () => {
    const instructions = await initializeInstructions()
    expect(instructions).toBe(KANBO_MCP_INSTRUCTIONS)
    expect(instructions).toContain('kanbo_prime')
    expect(instructions).toContain('kanbo_wait_approval')
    expect(instructions).toContain('kanbo://capabilities.md')
    // A card created at the wrong level is moved, not made again.
    expect(instructions).toContain('`kanbo_card_update` and `parent` (`"none"` for the top level)')
  })

  it('stay compact enough to sit in every session\'s context', () => {
    expect(KANBO_MCP_INSTRUCTIONS.length).toBeLessThanOrEqual(2500)
  })

  it('say the same rules as the command-line guide and prime', () => {
    for (const rule of [SUBTASK_RULE, WAIT_FOR_PERSON_RULE]) {
      expect(KANBO_MCP_INSTRUCTIONS).toContain(rule)
      expect(AGENT_GUIDE_TEXT).toContain(rule)
      expect(BOARD_RULES).toContain(rule)
    }
  })
})

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { KANBO_MCP_INSTRUCTIONS } from '../mcp/instructions'
import { createKanboMcpServer } from '../mcp/server'
import { registerInitCommand } from './commands/init'
import { NO_BOARD_FOR_AGENT_MESSAGE, openMcpBoard } from './mcp-board'

/** `kanbo mcp` in a folder that has no board — the case of a person's own, every-folder registration. */
describe('kanbo mcp in a folder with no board', () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'kanbo-mcp-no-board-'))
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir)
    for (const name of ['KANBO_DB_PATH', 'KANBO_WORKSPACE_ID', 'KANBO_DATABASE_URL', 'KANBO_ACTOR_KIND', 'CI', 'TERM']) {
      vi.stubEnv(name, undefined)
    }
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    rmSync(projectDir, { force: true, recursive: true })
  })

  async function connect(): Promise<{ client: Client, close: () => Promise<void> }> {
    const board = await openMcpBoard({ actor: { kind: 'external', id: 'tester' } })
    const server = createKanboMcpServer(board, { includeRunTools: true })
    const [clientChannel, serverChannel] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'no-board-test', version: '0.0.0' })
    await Promise.all([client.connect(clientChannel), server.connect(serverChannel)])
    return { client, close: async () => {
      await client.close()
      await board.close()
    } }
  }

  function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
    return (result.content as { type: string, text: string }[]).map(part => part.text).join('\n')
  }

  it('connects and hands the client its instructions', async () => {
    const { client, close } = await connect()
    try {
      expect(client.getInstructions()).toBe(KANBO_MCP_INSTRUCTIONS)
      expect((await client.listTools()).tools.map(tool => tool.name)).toContain('kanbo_ready')
    }
    finally {
      await close()
    }
  })

  it('answers every tool with the message that there is no board here', async () => {
    const { client, close } = await connect()
    try {
      for (const [name, args] of [['kanbo_ready', {}], ['kanbo_prime', {}], ['kanbo_card_create', { title: 'x' }]] as const) {
        const result = await client.callTool({ name, arguments: args })
        expect(result.isError, name).toBe(true)
        expect(textOf(result), name).toBe(NO_BOARD_FOR_AGENT_MESSAGE)
      }
    }
    finally {
      await close()
    }
  })

  it('finds a board a person sets up in the folder while it runs, on the next call', async () => {
    const { client, close } = await connect()
    try {
      expect((await client.callTool({ name: 'kanbo_ready', arguments: {} })).isError).toBe(true)

      const program = new Command().exitOverride()
      registerInitCommand(program)
      await program.parseAsync(['init', '--yes'], { from: 'user' })

      const created = await client.callTool({ name: 'kanbo_card_create', arguments: { title: 'First card', column: 'to_do' } })
      expect(created.isError, textOf(created)).toBeFalsy()
      const ready = await client.callTool({ name: 'kanbo_ready', arguments: {} })
      expect(ready.isError).toBeFalsy()
      expect(textOf(ready)).toContain('First card')
    }
    finally {
      await close()
    }
  })
})

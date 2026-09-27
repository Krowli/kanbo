import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { Command } from 'commander'

import { createKanboMcpServer } from '../../mcp/server'
import { createCliActor } from '../actor'
import { describeFailure } from '../failure'
import { openMcpBoard } from '../mcp-board'

/**
 * `kanbo mcp` — the board as tools, for any MCP client.
 *
 * It serves the board directly — the file, or the external database the project
 * is bound to — because the tool that spawned it — Claude Code, Codex, Cursor —
 * may be the only thing running on this machine: an agent working in a checkout
 * with no server should still be able to drive its card. An app with an MCP
 * server of its own can hold the same tools there instead, over HTTP
 * (`kanbo/mcp`).
 *
 * Every write is filed under this shell, exactly as every `kanbo` command's
 * is, and all sixteen tools are published: an agent that started itself has to
 * record its own run, which is the one thing an app that launches agents does
 * for them.
 *
 * In a folder with no board it starts all the same, and every tool says so
 * until a person sets one up (`mcp-board.ts`).
 */

/** What `kanbo mcp` is told, as every other command spells it. */
interface McpOptions {
  db?: string
  databaseUrl?: string
  workspace?: string
}

export function registerMcpCommand(program: Command): void {
  program
    .command('mcp')
    .description('Run the board\'s MCP server for an agent (it starts this itself)')
    // The output options every other command carries are absent on purpose:
    // stdout is the protocol here, and anything printed on it is a broken
    // session rather than a badly formatted one.
    .option('--db <path>', 'the board file to open')
    .option('--database-url <url>', 'a shared Postgres board to use instead of a board file')
    .option('--workspace <nameOrId>', 'the project, when this folder is not bound to one')
    .action(async (options: McpOptions) => {
      const board = await openMcpBoard({
        dbPath: options.db,
        databaseUrl: options.databaseUrl,
        workspaceId: options.workspace,
        actor: createCliActor(),
      })
      // Closed once, whichever way this ends. `onclose` is the client hanging
      // up and cannot be awaited — it is not an async hook — so the promise is
      // kept here and awaited by whoever gets there second. A connection that
      // fails to hang up is worth a line on stderr, which is not the protocol
      // stream, and never an unhandled rejection: that would turn a clean
      // shutdown into a crash.
      let closing: Promise<void> | undefined
      const close = (): Promise<void> => (closing ??= board.close().catch((error: unknown) => {
        console.error(describeFailure(error).message)
      }))

      const server = createKanboMcpServer(board, { includeRunTools: true })
      server.server.onclose = () => void close()
      try {
        await server.connect(new StdioServerTransport())
      }
      catch (error) {
        await close()
        throw error
      }
    })
}

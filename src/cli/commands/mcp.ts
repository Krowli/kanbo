import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Command } from 'commander'

import type { BoardActor } from '../../ops/types'
import { createKanboMcpServer } from '../../mcp/server'
import { createCliActor } from '../actor'
import { readAgentTool } from '../agent-shell'
import { describeFailure } from '../failure'
import { openMcpBoard, withUpdateNote } from '../mcp-board'
import { isUpdateCheckDisabled, startUpdateCheck } from '../update-check'

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
 * Every write is filed under this shell's agent (`KANBO_ACTOR_ID`, the agent
 * tool, or the name the MCP client gives when it connects), never the OS user,
 * and all sixteen tools are published: an agent that started itself has to
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

/**
 * The actor of a `kanbo mcp` session, which is always an agent's: `KANBO_ACTOR_ID`,
 * else the agent tool, else `agent` until the client says its name (see
 * `nameActorAfterClient`).
 */
export function createMcpActor(): { actor: BoardActor, namedByShell: boolean } {
  const tool = readAgentTool()
  const namedByShell = Boolean(process.env.KANBO_ACTOR_ID?.trim() || (tool && tool !== 'agent'))
  const actor = createCliActor()
  if (!namedByShell) {
    actor.id = 'agent'
  }
  return { actor, namedByShell }
}

/**
 * Files the session's writes under the client's own name (`Test Client` ->
 * `test-client`) once it has initialized. `actor` is the object the board
 * holds, so later writes see the new id.
 */
export function nameActorAfterClient(server: McpServer, actor: BoardActor): void {
  server.server.oninitialized = () => {
    const name = server.server.getClientVersion()?.name
    const id = name?.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 40)
    if (id) {
      actor.id = id
    }
  }
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
      const { actor, namedByShell } = createMcpActor()
      const board = await openMcpBoard({
        dbPath: options.db,
        databaseUrl: options.databaseUrl,
        workspaceId: options.workspace,
        actor,
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

      // Asked once, as the server starts; the answer only ever reaches `kanbo_prime`.
      const check = isUpdateCheckDisabled() ? null : startUpdateCheck()
      const server = createKanboMcpServer(check ? withUpdateNote(board, check.peek) : board, { includeRunTools: true })
      server.server.onclose = () => void close()
      if (!namedByShell) {
        nameActorAfterClient(server, actor)
      }
      try {
        await server.connect(new StdioServerTransport())
      }
      catch (error) {
        await close()
        throw error
      }
    })
}

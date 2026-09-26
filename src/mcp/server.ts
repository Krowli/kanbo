import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { KANBO_PACKAGE_VERSION } from '../package-version'
import { KANBO_MCP_INSTRUCTIONS } from './instructions'
import { registerKanboCapabilitiesResources } from './resources'
import type { KanboToolOptions } from './tools'
import { buildKanboTools } from './tools'
import type { KanboToolTransport } from './transport'

/** The name a client sees this server under. */
export const KANBO_MCP_SERVER_NAME = 'kanbo'

/** The version it reports. The tools it carries are the board's, and the board versions itself. */
const KANBO_MCP_SERVER_VERSION = KANBO_PACKAGE_VERSION

/**
 * Add the board's tools to a server that already exists.
 *
 * This is how an app with an MCP server of its own carries them: one server holds every
 * tool an agent has, and the board's are part of that inventory rather than a
 * second server the runtime would have to be told about.
 */
export function registerKanboTools(
  server: McpServer,
  transport: KanboToolTransport,
  options: KanboToolOptions,
): void {
  for (const tool of buildKanboTools(transport, options)) {
    tool.register(server)
  }
}

/**
 * A server that is only the board — what `kanbo mcp` serves to a client that
 * brings no board tools of its own: an editor, an agent CLI, another machine.
 *
 * It carries the capabilities manifest as two resources, on top of the tools
 * `registerKanboTools` adds — a client here has no other way to learn the
 * board's rules, its canonical strings or its CLI equivalents before it calls
 * anything. An app's own MCP server does not get them through this
 * function: it documents its capabilities its own way, and adding a second
 * `kanbo://` resource namespace to an inventory that is not only the board's
 * is a decision for that server to make, not this one.
 *
 * For the same reason it alone sends `KANBO_MCP_INSTRUCTIONS` in the initialize
 * result: the instructions of a server that is only the board.
 */
export function createKanboMcpServer(
  transport: KanboToolTransport,
  options: KanboToolOptions,
): McpServer {
  const server = new McpServer({
    name: KANBO_MCP_SERVER_NAME,
    version: KANBO_MCP_SERVER_VERSION,
  }, { instructions: KANBO_MCP_INSTRUCTIONS })
  registerKanboTools(server, transport, options)
  registerKanboCapabilitiesResources(server)
  return server
}

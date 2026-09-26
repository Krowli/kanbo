import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js'

import { buildCapabilitiesManifest } from '../capabilities/manifest'
import { renderCapabilitiesMarkdown } from '../capabilities/markdown'

/** The URI a client reads the manifest as JSON from. */
export const KANBO_CAPABILITIES_RESOURCE_URI = 'kanbo://capabilities'

/** The URI a client reads the same manifest from, laid out as Markdown. */
export const KANBO_CAPABILITIES_MARKDOWN_RESOURCE_URI = 'kanbo://capabilities.md'

/**
 * The board's own capabilities manifest, as two MCP resources rather than a
 * tool: a client reads it once, before it ever calls a board tool, to learn
 * what the tools take and what the board promises and refuses. `kanbo
 * capabilities` prints the same two shapes from a terminal.
 *
 * Registered on the server `kanbo mcp` builds for itself rather than on
 * `registerKanboTools` — the function an app's own MCP server calls to add the
 * board's tools to an inventory of its own — so an agent inside such an app
 * reads the manifest the way that app documents everything else, and a client
 * with no server around it still gets the manifest from the one server it is
 * talking to.
 */
export function registerKanboCapabilitiesResources(server: McpServer): void {
  server.registerResource(
    'kanbo-capabilities',
    KANBO_CAPABILITIES_RESOURCE_URI,
    {
      title: 'Kanbo capabilities',
      description: 'The board\'s tools with their input schemas, its CLI commands, the rules a card travels by, '
        + 'the canonical strings the board writes, the roles it enforces, and what it refuses — as JSON.',
      mimeType: 'application/json',
    },
    (uri): ReadResourceResult => ({
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(buildCapabilitiesManifest(), null, 2) }],
    }),
  )

  server.registerResource(
    'kanbo-capabilities-markdown',
    KANBO_CAPABILITIES_MARKDOWN_RESOURCE_URI,
    {
      title: 'Kanbo capabilities (Markdown)',
      description: 'The same manifest as kanbo://capabilities, laid out as Markdown — suitable for pasting '
        + 'into a CLAUDE.md or an AGENTS.md.',
      mimeType: 'text/markdown',
    },
    (uri): ReadResourceResult => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: renderCapabilitiesMarkdown(buildCapabilitiesManifest()) }],
    }),
  )
}

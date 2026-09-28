import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import type { KanboToolName } from '../tool-names'
import type { KanboToolTransport } from '../transport'
import { cardCommentTool } from './card-comment'
import { cardCreateTool } from './card-create'
import { cardGetTool } from './card-get'
import { cardLinkPrTool } from './card-link-pr'
import { cardListTool } from './card-list'
import { cardMoveTool } from './card-move'
import { cardPullRequestsTool } from './card-pull-requests'
import { cardUpdateTool } from './card-update'
import { columnsTool } from './columns'
import { primeTool } from './prime'
import { readyTool } from './ready'
import { runFinishTool } from './run-finish'
import { runStartTool } from './run-start'
import { sprintsTool } from './sprints'
import { statusLineTool } from './status-line'
import type { KanboTool } from './tool'
import { waitApprovalTool } from './wait-approval'

/**
 * Every tool the board has, in the order it declares them.
 *
 * The list is the board's, not a server's: the same sixteen are registered
 * whether they run against a server or against the board directly, and the
 * only thing a host decides is which of them it publishes.
 */
export const KANBO_TOOLS: readonly KanboTool[] = [
  primeTool,
  readyTool,
  columnsTool,
  sprintsTool,
  cardGetTool,
  cardListTool,
  cardCreateTool,
  cardUpdateTool,
  cardMoveTool,
  cardCommentTool,
  cardLinkPrTool,
  cardPullRequestsTool,
  statusLineTool,
  waitApprovalTool,
  runStartTool,
  runFinishTool,
]

/**
 * The two tools an agent launched by an app has no use for: the app wrote the
 * run row before the agent started and ends it when the session settles. An agent
 * that launched itself — from a terminal, on another host — does have to record
 * its own run, which is why they exist at all.
 */
const RUN_TOOL_NAMES: readonly KanboToolName[] = ['kanbo_run_start', 'kanbo_run_finish']

/** What a host decides about the board's tools. */
export interface KanboToolOptions {
  /** Publish `kanbo_run_start` and `kanbo_run_finish`. False for a host that manages runs itself. */
  includeRunTools: boolean
}

/** One tool bound to a transport, ready for an MCP server to register. */
export interface KanboToolRegistration {
  name: KanboToolName
  register: (server: McpServer) => void
}

/**
 * The board's tools, bound to the transport they run against.
 *
 * Nothing here reaches the board: the registration is what an MCP server needs
 * to publish the tool, and the transport is only called when a client actually
 * calls one.
 */
export function buildKanboTools(
  transport: KanboToolTransport,
  options: KanboToolOptions,
): KanboToolRegistration[] {
  return KANBO_TOOLS
    .filter(tool => options.includeRunTools || !RUN_TOOL_NAMES.includes(tool.name))
    .map(tool => ({
      name: tool.name,
      register: (server: McpServer) => {
        server.registerTool(
          tool.name,
          { title: tool.title, description: tool.description, inputSchema: tool.registrationSchema },
          async (input: unknown) => await tool.run(transport, input),
        )
      },
    }))
}

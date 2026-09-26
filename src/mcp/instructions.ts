import {
  COMMENT_RULE,
  MOVE_CARD_RULE,
  PERSON_ONLY_RULE,
  STATUS_LINE_RULE,
  SUBTASK_RULE,
  WAIT_FOR_PERSON_RULE,
} from '../ops/agent-rules'
import { KANBO_CAPABILITIES_MARKDOWN_RESOURCE_URI } from './resources'
import type { KanboToolName } from './tool-names'

/** A tool name as the instructions print it — typed, so a renamed tool fails the build here. */
function tool(name: KanboToolName): string {
  return `\`${name}\``
}

/**
 * What `kanbo mcp` tells a client when it connects — the `instructions` of the
 * MCP initialize result, which a client hands its model before any tool is
 * called. An agent with nothing but this server connected learns from it how
 * to work the board, with no instruction file in the project.
 *
 * Static on purpose: it is sent before any board is resolved, so it says
 * nothing about columns — `kanbo_prime` returns those. The rules are the
 * sentences `ops/agent-rules.ts` holds for every surface, with the tool beside
 * each; the full manifest stays a resource.
 */
export const KANBO_MCP_INSTRUCTIONS = [
  'kanbo is a kanban board shared by people and agents; these tools read and change its cards.',
  '',
  `- At the start of a session call ${tool('kanbo_prime')} — it returns this board's columns and what each one means.`,
  `- Take work from ${tool('kanbo_ready')}.`,
  `- ${MOVE_CARD_RULE} (${tool('kanbo_card_move')})`,
  `- ${STATUS_LINE_RULE} (${tool('kanbo_status_line')})`,
  `- ${COMMENT_RULE} (${tool('kanbo_card_comment')})`,
  `- ${SUBTASK_RULE} (${tool('kanbo_card_create')} with \`parent\`)`,
  `- ${WAIT_FOR_PERSON_RULE} (${tool('kanbo_wait_approval')})`,
  `- ${PERSON_ONLY_RULE}`,
  `- Every tool, rule and canonical string: the resource \`${KANBO_CAPABILITIES_MARKDOWN_RESOURCE_URI}\`.`,
].join('\n')

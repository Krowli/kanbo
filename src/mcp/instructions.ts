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
 * to work the board; kanbo writes no instruction file.
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
  `- Take work from ${tool('kanbo_ready')}, and claim the card with ${tool('kanbo_card_claim')} before you start: it starts your run and moves the card into work in one step, so no other agent takes it. When you stop, finish the run with ${tool('kanbo_run_finish')}.`,
  `- ${MOVE_CARD_RULE} (${tool('kanbo_card_move')})`,
  `- ${STATUS_LINE_RULE} (${tool('kanbo_status_line')})`,
  `- ${COMMENT_RULE} (${tool('kanbo_card_comment')})`,
  `- ${SUBTASK_RULE} (${tool('kanbo_card_create')} with \`parent\`)`,
  `- A card at the wrong level is moved with ${tool('kanbo_card_update')} and \`parent\` (\`"none"\` for the top level).`,
  `- ${WAIT_FOR_PERSON_RULE} (${tool('kanbo_wait_approval')})`,
  `- ${PERSON_ONLY_RULE}`,
  '- If a tool answers that this folder has no kanbo board, leave the board alone for this session: only a person sets one up.',
  `- Every tool, rule and canonical string: the resource \`${KANBO_CAPABILITIES_MARKDOWN_RESOURCE_URI}\`.`,
].join('\n')

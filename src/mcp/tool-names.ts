/**
 * The board's tools, named once.
 *
 * An agent reaches this board through an MCP server, or through an HTTP API
 * (`kanbo serve`, or an app that serves the same routes), and both must agree on
 * what the board can be asked to do. The names are read by the MCP server, by
 * the prompts built for an agent and by the HTTP API — there is no command line
 * for an agent. They live here rather than in the MCP server so that a prompt
 * built for an agent and the tools that agent actually holds cannot drift
 * apart: both read this list.
 *
 * Nothing here executes anything. These are names, for a prompt and for
 * documentation.
 */
export const KANBO_TOOL_NAMES = [
  'kanbo_prime',
  'kanbo_ready',
  'kanbo_card_claim',
  'kanbo_columns',
  'kanbo_sprints',
  'kanbo_card_get',
  'kanbo_card_list',
  'kanbo_card_create',
  'kanbo_card_update',
  'kanbo_card_move',
  'kanbo_card_comment',
  'kanbo_card_link_pr',
  'kanbo_card_pull_requests',
  'kanbo_status_line',
  'kanbo_wait_approval',
  'kanbo_run_start',
  'kanbo_run_finish',
] as const

/** One of the board's tools. */
export type KanboToolName = typeof KANBO_TOOL_NAMES[number]

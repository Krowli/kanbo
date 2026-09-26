/**
 * The board's tools, named once.
 *
 * An agent reaches this board through an MCP server, through a command line, or
 * through an HTTP API (`kanbo serve`, or an app that serves the same routes),
 * and the three must agree on what the board can be asked to do. The names live
 * here rather than in the MCP server so that a prompt built for an agent and the
 * tools that agent actually holds cannot drift apart: both read this list.
 *
 * Nothing here executes anything. These are names and the commands that mean
 * the same thing, for a prompt and for documentation.
 */
export const KANBO_TOOL_NAMES = [
  'kanbo_prime',
  'kanbo_ready',
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

/** The command line that does what a tool does. */
export interface KanboToolCliEquivalent {
  /** The `kanbo` command, which needs no server. */
  kanbo: string
}

/**
 * What to type instead of calling the tool.
 *
 * An agent without MCP tools is not shut out of the board: every tool has a
 * command that does the same thing, and the card ends up saying the same
 * either way, because both call the same operations.
 */
export const KANBO_TOOL_CLI_EQUIVALENTS: Record<KanboToolName, KanboToolCliEquivalent> = {
  kanbo_prime: {
    kanbo: 'kanbo prime',
  },
  kanbo_ready: {
    kanbo: 'kanbo ready',
  },
  kanbo_columns: {
    kanbo: 'kanbo columns list',
  },
  kanbo_sprints: {
    kanbo: 'kanbo sprint list',
  },
  kanbo_card_get: {
    kanbo: 'kanbo card get <id>',
  },
  kanbo_card_list: {
    kanbo: 'kanbo card list',
  },
  kanbo_card_create: {
    kanbo: 'kanbo card create --description <text> [--title <title>] [--parent <id>]',
  },
  kanbo_card_update: {
    kanbo: 'kanbo card update <id> [--title <title>] [--description <text>]',
  },
  kanbo_card_move: {
    kanbo: 'kanbo card move <id> <column>',
  },
  kanbo_card_comment: {
    kanbo: 'kanbo card comment <id> --content <text>',
  },
  kanbo_card_link_pr: {
    kanbo: 'kanbo card pr add <id> <url>',
  },
  kanbo_card_pull_requests: {
    kanbo: 'kanbo card pr list <id>',
  },
  kanbo_status_line: {
    kanbo: 'kanbo card status-line <id> --text <text>',
  },
  kanbo_wait_approval: {
    kanbo: 'kanbo card wait-approval <id> [--text <text>]',
  },
  kanbo_run_start: {
    kanbo: 'kanbo run start <id> --agent <name> [--session <ref>]',
  },
  kanbo_run_finish: {
    kanbo: 'kanbo run finish <runId> --state <state>',
  },
}

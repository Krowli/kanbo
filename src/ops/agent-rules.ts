/**
 * The sentences that tell an agent how to work this board, written once.
 *
 * Four surfaces say them: the text `kanbo prime` returns (`BOARD_RULES`), the
 * block `kanbo init` writes into a project's `CLAUDE.md` / `AGENTS.md`, the
 * `instructions` the `kanbo mcp` server sends when a client connects, and the
 * `kanbo_card_create` tool's description. Each surface adds its own way of
 * doing the thing — a command, a tool name — but the rule itself is read from
 * here, so the four cannot come to say different things.
 *
 * No sentence names a tool or a command: the same text reaches an agent holding
 * MCP tools, one with a command line, and one talking to a server over HTTP.
 */

export const MOVE_CARD_RULE = 'You move the card between columns yourself, at the moment its real state changes. The board never moves a card for you.'

export const STATUS_LINE_RULE = 'Write a status line at every step, including before and after anything long-running. One sentence, present tense, about what is happening right now.'

export const WAIT_FOR_PERSON_RULE = 'When you need a person, mark the card as waiting for approval and end your turn. You will be told when the answer comes.'

export const PERSON_ONLY_RULE = 'Only a person approves a card, and only a person takes one out of waiting. Never do either yourself.'

export const EXECUTION_MODE_RULE = 'Each card says where it runs: `worktree` means a separate copy of the project, `main` means the project folder itself. Work in the mode the card names.'

/** When to split a card at all — said on its own where the surface names the parent its own way. */
export const SUBTASK_WHEN_SENTENCE = 'Create subtasks only when the person asks for them, or when a task has parts that can be done and checked separately (different stages, owners or pull requests); do not split small work you will finish in one go.'

/** How to split one, with the way this surface names the parent card. */
export function subtaskSplitSentence(parentReference: string): string {
  return `When you do split a card, make the parts subtasks of it (${parentReference}), not separate top-level cards.`
}

export const SUBTASK_RULE = `${SUBTASK_WHEN_SENTENCE} ${subtaskSplitSentence('the parent card\'s id')}`

export const PULL_REQUEST_RULE = 'Opened a pull request? Link it to the card. Its state and CI checks then reach the card as comments on their own — nothing else tells the board a pull request exists.'

export const OWN_SESSION_RULE = 'Started the work yourself, not launched by an app that tracks the run for you? Say so when you start the run — `claude:<session id>` from Claude Code, `codex:<session id>` from Codex (the session id Codex prints) — so your own log of it can be found later.'

/** Said by the `kanbo init` block and the MCP instructions, which name the comment command or tool beside it. */
export const COMMENT_RULE = 'Findings, results, decisions and questions go on the card as comments.'

export const BOARD_TOOLS_RULE = 'Read the column descriptions above before moving a card, and do all of this through the board tools or commands you have — a statement in your reply changes nothing.'

/**
 * The rules of this board, as `kanbo prime` says them under its column list.
 *
 * They are about the board and nothing else. The board does not hand out a role, a
 * method or a pipeline — that belongs to the instructions the person wrote for
 * their own agent — so the list stops at what the board itself guarantees and
 * expects.
 *
 * Also the source `buildCapabilitiesManifest` reads its `rules` from — one list,
 * read by the prompt an agent sees and by the manifest an orchestrator reads
 * about the board.
 */
export const BOARD_RULES = [
  MOVE_CARD_RULE,
  STATUS_LINE_RULE,
  WAIT_FOR_PERSON_RULE,
  PERSON_ONLY_RULE,
  EXECUTION_MODE_RULE,
  SUBTASK_RULE,
  PULL_REQUEST_RULE,
  OWN_SESSION_RULE,
  BOARD_TOOLS_RULE,
]

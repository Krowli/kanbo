import type { BoardStore } from '../board-store'
import { ENTRY_RULE_DESCRIPTIONS, readEntryRules } from '../domain/entry-rules'
import { normalizeStatusName } from '../domain/status-name'
import type { IssueStatus } from '../sqlite/schema'
import { listColumns } from './columns'

/**
 * The rules of this board, as an agent needs to hear them.
 *
 * They are about the board and nothing else. The board does not hand out a role, a
 * method or a pipeline — that belongs to the instructions the person wrote for
 * their own agent — so the list stops at what the board itself guarantees and
 * expects. No tool is named either: the same text reaches an agent holding MCP
 * tools, one with a command line, and one talking to a server over HTTP, and each
 * of them already knows what it is holding.
 *
 * Exported because it is also the source `buildCapabilitiesManifest` reads its
 * `rules` from — one list, read by the prompt an agent sees and by the manifest
 * an orchestrator reads about the board.
 */
export const BOARD_RULES = [
  'You move the card between columns yourself, at the moment its real state changes. The board never moves a card for you.',
  'Write a status line at every step, including before and after anything long-running. One sentence, present tense, about what is happening right now.',
  'When you need a person, mark the card as waiting for approval and end your turn. You will be told when the answer comes.',
  'Only a person approves a card, and only a person takes one out of waiting. Never do either yourself.',
  'Each card says where it runs: `worktree` means a separate copy of the project, `main` means the project folder itself. Work in the mode the card names.',
  'Create subtasks only when the person asks for them, or when a task has parts that can be done and checked separately (different stages, owners or pull requests); do not split small work you will finish in one go. When you do split a card, make the parts subtasks of it (the parent card\'s id), not separate top-level cards.',
  'Opened a pull request? Link it to the card. Its state and CI checks then reach the card as comments on their own — nothing else tells the board a pull request exists.',
  'Started the work yourself, not launched by an app that tracks the run for you? Say so when you start the run — `claude:<session id>` from Claude Code, `codex:<session id>` from Codex (the session id Codex prints) — so your own log of it can be found later.',
  'Read the column descriptions above before moving a card, and do all of this through the board tools or commands you have — a statement in your reply changes nothing.',
]

/**
 * What the board tells an agent about itself: the columns it has, what each one
 * means, and how a card is expected to travel across them.
 *
 * The text is the same whether it reaches the agent in a prompt an app builds
 * or through a tool the agent called on its own.
 */
export async function buildPrimeText(store: BoardStore, workspaceId: string): Promise<string> {
  const columns = await listColumns(store, workspaceId)
  const ruled = columns.some(column => readEntryRules(column).length > 0)
  const lines = [
    'Columns of this board, in board order:',
    '',
    ...(columns.length > 0 ? columns.map(describeColumnLine) : ['- (this board has no columns yet)']),
    ...(ruled ? ['', ENTRY_RULES_NOTE] : []),
    '',
    'How this board works:',
    '',
    ...BOARD_RULES.map(rule => `- ${rule}`),
  ]
  return lines.join('\n')
}

/**
 * Said under the columns only when one of them has entry rules, so a board
 * without any reads exactly as it did before they existed.
 */
const ENTRY_RULES_NOTE = 'A column that lists requirements refuses a card that does not meet them yet, with the list of what is missing: do that work first, then move the card. A person may still move it.'

function describeColumnLine(column: IssueStatus): string {
  const slug = normalizeStatusName(column.name)
  const rules = readEntryRules(column)
  const requires = rules.length > 0
    ? ` Requires: ${rules.map(rule => `${rule} (${ENTRY_RULE_DESCRIPTIONS[rule]})`).join('; ')}.`
    : ''
  return column.description
    ? `- ${column.name} (\`${slug}\`) — ${column.description}${requires}`
    : `- ${column.name} (\`${slug}\`)${requires ? ` —${requires}` : ''}`
}

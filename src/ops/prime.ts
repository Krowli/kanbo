import type { BoardStore } from '../board-store'
import { ENTRY_RULE_DESCRIPTIONS, readEntryRules } from '../domain/entry-rules'
import { normalizeStatusName } from '../domain/status-name'
import type { IssueStatus } from '../sqlite/schema'
import { BOARD_RULES } from './agent-rules'
import { listColumns } from './columns'

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

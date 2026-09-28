import type { BoardStore } from '../board-store'
import { ENTRY_RULE_DESCRIPTIONS, readEntryRules } from '../domain/entry-rules'
import { normalizeStatusName } from '../domain/status-name'
import type { IssueStatus } from '../sqlite/schema'
import { cardDisplayTitle } from '../domain/card-display-title'
import { BOARD_RULES } from './agent-rules'
import { readCardAttention } from './approval'
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
    ...await describeReturnedCards(store, workspaceId, columns),
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

/** How many returned cards the prime text lists, at most. */
const PRIME_RETURNED_LIMIT = 5

/**
 * The cards a person sent back that nobody picked up again, said first — an
 * agent told to "continue the returned card" had nothing that named it, and
 * searched the board list by list (docs/performance.md). Nothing at all when
 * there are none, so a board without any reads as it always did.
 */
async function describeReturnedCards(store: BoardStore, workspaceId: string, columns: IssueStatus[]): Promise<string[]> {
  const page = await store.issues.listPage({ workspaceId, returned: true, limit: PRIME_RETURNED_LIMIT })
  if (page.cards.length === 0) {
    return []
  }
  const attention = await readCardAttention(store, page.cards, page.cards.map(() => false))
  const more = page.total - page.cards.length
  return [
    'Returned to you — a person sent these back. Read their comment, do what it asks, then hand the card back to a person:',
    '',
    ...page.cards.map((card, index) => {
      const column = columns.find(candidate => candidate.id === card.statusId)
      const where = column ? ` (\`${normalizeStatusName(column.name)}\`)` : ''
      const comment = attention[index]!.lastComment
      return `- ${card.id} ${cardDisplayTitle(card)}${where}${comment ? ` — ${comment.author === 'user' ? 'person' : comment.author}: ${JSON.stringify(comment.text)}` : ''}`
    }),
    ...(more > 0 ? [`- … and ${more} more: list them with the returned filter`] : []),
    '',
  ]
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

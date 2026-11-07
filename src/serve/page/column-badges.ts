import type { ServeCardView, ServeStatusView } from '../views'

/**
 * What a column's header says about its load and its doors: a count (or
 * `n/limit` against a WIP limit) and a lock whose tooltip lists the rules in
 * words. Read from what the statuses already carry — `wipLimit`,
 * `allowedFrom` and `entryRules` — and nothing else.
 */

export interface ColumnBadge {
  text: string
  /** At the column's limit or over it: drawn in the warning colour. */
  full: boolean
}

/**
 * `shown` is how many of the column's cards the filters let through; `total`
 * is every card in it. A column with a limit shows `total/limit` — a limit
 * counts the cards that are there, not the ones in view.
 */
export function columnBadge(status: ServeStatusView | null, shown: number, total: number): ColumnBadge {
  const limit = status?.wipLimit ?? null
  if (limit === null) {
    return { text: String(shown), full: false }
  }
  return { text: `${total}/${limit}`, full: total >= limit }
}

const RULE_WORDS: Record<string, string> = {
  checklist_complete: 'every checklist item checked',
  pull_request_linked: 'a pull request linked',
  ci_green: 'CI green',
  approved: 'a person\'s approval',
}

/** The column's rules in words, one per line, or `null` when it has none. */
export function columnRules(status: ServeStatusView, statuses: readonly ServeStatusView[]): string | null {
  const lines: string[] = []
  if (status.allowedFrom !== null) {
    const names = status.allowedFrom.map(id => statuses.find(candidate => candidate.id === id)?.name ?? id)
    lines.push(names.length === 0 ? 'Only a person puts a card here' : `Accepts cards only from ${names.join(', ')}`)
  }
  if (status.wipLimit !== null) {
    lines.push(`Limit: ${status.wipLimit} ${status.wipLimit === 1 ? 'card' : 'cards'}`)
  }
  if (status.entryRules.length > 0) {
    lines.push(`A card needs: ${status.entryRules.map(rule => RULE_WORDS[rule] ?? rule).join('; ')}`)
  }
  return lines.length === 0 ? null : lines.join('\n')
}

/**
 * How many cards each column holds by the card's own column: a sub-task drawn
 * inside a parent in another column still counts in the column it is in.
 * `include` narrows the cards counted (the filters); omit it for all of them.
 */
export function countByStatus(cards: readonly ServeCardView[], include: (card: ServeCardView) => boolean = () => true): Map<string, number> {
  const counts = new Map<string, number>()
  for (const card of cards) {
    if (card.statusId !== null && include(card)) {
      counts.set(card.statusId, (counts.get(card.statusId) ?? 0) + 1)
    }
  }
  return counts
}

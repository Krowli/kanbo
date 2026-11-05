import type { IssueStatus } from '../sqlite/schema'
import type { UnmetEntryRule } from './entry-rules'
import { normalizeStatusName } from './status-name'

/**
 * Where a card may come from before it enters a column, and how many cards the
 * column holds (board-workflow spec, Part 2). Checked at the same door as the
 * entry rules, `enforceColumnEntry`, for every writer.
 *
 * - `allowedFrom` — the ids of the columns a card may enter this one from;
 *   `null` for any column. `[]` lets no card in from another column, so only a
 *   person puts one there — it is also what a list becomes when its last column
 *   is deleted, so a guarded column never opens by accident.
 * - `wipLimit` — the most cards the column holds, 1 or more; `null` for no
 *   limit. The card entering is not counted.
 */
export interface ColumnFlowRules {
  allowedFrom: string[] | null
  wipLimit: number | null
}

/** The two flow rules, as an unmet entry names them. */
export const FLOW_RULES = ['allowed_from', 'wip_limit'] as const

export type FlowRule = typeof FLOW_RULES[number]

/** The column the standard flow guards, and the columns it lets cards in from, by slug. */
export const STANDARD_FLOW_TARGET = 'done'
export const STANDARD_FLOW_SOURCES = ['in_review', 'qa'] as const

/** A column's flow rules, out of what the row stores. */
export function readFlowRules(column: Pick<IssueStatus, 'allowedFrom' | 'wipLimit'>): ColumnFlowRules {
  return {
    allowedFrom: column.allowedFrom === null ? null : JSON.parse(column.allowedFrom) as string[],
    wipLimit: column.wipLimit,
  }
}

/** A list of column ids as the row stores it: `null` stays `null`, and an empty list stays an empty list. */
export function serializeAllowedFrom(allowedFrom: readonly string[] | null): string | null {
  return allowedFrom === null ? null : JSON.stringify(allowedFrom)
}

/** What a flow check needs beyond the card and the column. */
export interface FlowRuleFacts {
  /** The names of the board's columns, by id — for saying where cards may come from. */
  columnNames: ReadonlyMap<string, string>
  /** The cards in the column now, plus those this same write let in before this one. */
  cardsInColumn: number
}

/**
 * The flow rules a card entering `column` does not meet, where it may come from
 * first. Pure: what the board holds arrives in `facts`. A card being created
 * comes from no column, so a column that names where cards come from does not
 * take it.
 */
export function evaluateFlowRules(
  card: { statusId: string | null },
  column: Pick<IssueStatus, 'name'>,
  rules: ColumnFlowRules,
  facts: FlowRuleFacts,
): UnmetEntryRule[] {
  const unmet: UnmetEntryRule[] = []
  if (rules.allowedFrom !== null && (card.statusId === null || !rules.allowedFrom.includes(card.statusId))) {
    unmet.push({ rule: 'allowed_from', reason: 'not_allowed_from', detail: describeAllowedFrom(column.name, rules.allowedFrom, facts.columnNames) })
  }
  if (rules.wipLimit !== null && facts.cardsInColumn >= rules.wipLimit) {
    unmet.push({ rule: 'wip_limit', reason: 'column_full', detail: `${column.name} holds ${facts.cardsInColumn} of ${rules.wipLimit}` })
  }
  return unmet
}

function describeAllowedFrom(name: string, allowedFrom: readonly string[], columnNames: ReadonlyMap<string, string>): string {
  const names = allowedFrom.map(id => columnNames.get(id)).filter((found): found is string => found !== undefined)
  return names.length === 0
    ? `${name} accepts cards from no column; only a person may put a card here`
    : `${name} accepts cards from ${joinWords(names)} only`
}

/** `A`, `A and B`, `A, B and C`. */
export function joinWords(words: readonly string[]): string {
  return words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`
}

/**
 * The standard flow on these columns: Done, and the columns it takes cards from
 * — In Review, and QA when there is one — in board order. `null` when the board
 * has no Done, or neither of the two.
 */
export function standardFlowOf<TColumn extends Pick<IssueStatus, 'name'>>(columns: readonly TColumn[]): { target: TColumn, sources: TColumn[] } | null {
  const target = columns.find(column => normalizeStatusName(column.name) === STANDARD_FLOW_TARGET)
  const sources = columns.filter(column => (STANDARD_FLOW_SOURCES as readonly string[]).includes(normalizeStatusName(column.name)))
  return target && sources.length > 0 ? { target, sources } : null
}

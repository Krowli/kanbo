import type { ServeCardView, ServeStatusView } from '../views'

/**
 * Sub-tasks, as the board lays them out. A card whose `parentIssueId` names a
 * card that is loaded is a **child**; one whose parent is not loaded is an
 * **orphan** and is drawn like any top-level card. Everything here is a pure
 * function of the loaded cards and columns, so it is tested with no DOM.
 *
 * Two modes: `inside` draws a child only as a row in its parent's card;
 * `cards` draws every card in its own column, children marked as such.
 */

export type SubtaskMode = 'inside' | 'cards'

export interface SubtaskSummary { total: number, done: number }

/** Most rows a parent's card lists before "+N more". */
export const MAX_SUBTASK_ROWS = 5

/** The sub-tasks of `cardId`, in board order (column order, then `order`). */
export function childrenOf(cards: readonly ServeCardView[], statuses: readonly ServeStatusView[], cardId: string): ServeCardView[] {
  const rank = (card: ServeCardView): number => {
    const index = statuses.findIndex(status => status.id === card.statusId)
    return index === -1 ? statuses.length : index
  }
  return cards
    .filter(card => card.parentIssueId === cardId && card.id !== cardId)
    .sort((a, b) => rank(a) - rank(b) || a.order - b.order)
}

/** How many of them are done (category `completed`); canceled ones count in neither number. `null` when there are none. */
export function subtaskSummary(cards: readonly ServeCardView[], statuses: readonly ServeStatusView[], cardId: string): SubtaskSummary | null {
  const categoryOf = (card: ServeCardView) => statuses.find(status => status.id === card.statusId)?.category
  const counted = childrenOf(cards, statuses, cardId).filter(card => categoryOf(card) !== 'canceled')
  if (counted.length === 0) {
    return null
  }
  return { total: counted.length, done: counted.filter(card => categoryOf(card) === 'completed').length }
}

/** The parent card, or `null` (no parent, or a parent not on this board). */
export function parentOf(cards: readonly ServeCardView[], card: ServeCardView): ServeCardView | null {
  if (!card.parentIssueId || card.parentIssueId === card.id) {
    return null
  }
  return cards.find(candidate => candidate.id === card.parentIssueId) ?? null
}

/**
 * Whether `card` is a child: its parent is loaded. A card caught in a loop of
 * parents (A under B under A) is not one, so it is drawn rather than lost.
 */
export function isChild(cards: readonly ServeCardView[], card: ServeCardView): boolean {
  const seen = new Set([card.id])
  let current = parentOf(cards, card)
  if (current === null) {
    return false
  }
  while (current !== null) {
    if (seen.has(current.id)) {
      return false
    }
    seen.add(current.id)
    current = parentOf(cards, current)
  }
  return true
}

/** The cards drawn in the columns: every card in `cards` mode, those that are not children in `inside` mode. */
export function drawnCards(cards: readonly ServeCardView[], mode: SubtaskMode): ServeCardView[] {
  return mode === 'cards' ? [...cards] : cards.filter(card => !isChild(cards, card))
}

/** The direct children a parent's card lists as rows, at most `MAX_SUBTASK_ROWS`, and how many more there are. */
export function subtaskRows(cards: readonly ServeCardView[], statuses: readonly ServeStatusView[], cardId: string): { rows: ServeCardView[], more: number } {
  const all = childrenOf(cards, statuses, cardId)
  return { rows: all.slice(0, MAX_SUBTASK_ROWS), more: Math.max(0, all.length - MAX_SUBTASK_ROWS) }
}

/** Every card under `cardId`, at any depth, each once. */
export function descendantsOf(cards: readonly ServeCardView[], cardId: string): ServeCardView[] {
  const found: ServeCardView[] = []
  const seen = new Set([cardId])
  const queue = [cardId]
  while (queue.length > 0) {
    const id = queue.shift()!
    for (const card of cards) {
      if (card.parentIssueId === id && !seen.has(card.id)) {
        seen.add(card.id)
        found.push(card)
        queue.push(card.id)
      }
    }
  }
  return found
}

/** Whether any card under `cardId`, at any depth, waits for a person. */
export function waitsBelow(cards: readonly ServeCardView[], cardId: string): boolean {
  return descendantsOf(cards, cardId).some(card => card.waitingFor === 'human')
}

/** Whether any card under `cardId`, at any depth, has a run going. */
export function runsBelow(cards: readonly ServeCardView[], cardId: string): boolean {
  return descendantsOf(cards, cardId).some(card => card.activeRun?.state === 'running')
}

export interface FamilyView {
  /** The ids of the cards drawn in columns. */
  drawn: Set<string>
  /** Direct sub-task rows inside a drawn parent that do not match: drawn at half opacity. */
  faded: Set<string>
  /** The toolbar's count: the cards drawn plus the sub-tasks under them that match. */
  count: number
}

/**
 * What a filter shows. In `cards` mode, each card on its own. In `inside` mode a
 * family goes together: a top-level card is drawn when it, or any card under it
 * at any depth, matches, and the sub-task rows that do not match (nor hold a
 * match) are faded rather than hidden.
 */
export function familyView(cards: readonly ServeCardView[], mode: SubtaskMode, matches: (card: ServeCardView) => boolean): FamilyView {
  if (mode === 'cards') {
    const drawn = new Set(cards.filter(matches).map(card => card.id))
    return { drawn, faded: new Set(), count: drawn.size }
  }
  const drawn = new Set<string>()
  const faded = new Set<string>()
  let count = 0
  for (const top of drawnCards(cards, 'inside')) {
    const below = descendantsOf(cards, top.id)
    const matching = new Set(below.filter(matches).map(card => card.id))
    if (!matches(top) && matching.size === 0) {
      continue
    }
    drawn.add(top.id)
    count += 1 + matching.size
    for (const child of cards.filter(card => card.parentIssueId === top.id && card.id !== top.id)) {
      const holdsMatch = matching.has(child.id) || descendantsOf(cards, child.id).some(card => matching.has(card.id))
      if (!holdsMatch) {
        faded.add(child.id)
      }
    }
  }
  return { drawn, faded, count }
}

export interface SubtaskRow {
  card: ServeCardView
  /** The category of the column the sub-task is in. */
  category: ServeStatusView['category'] | null
  /** Its own sub-tasks' progress, for "n/m". */
  own: SubtaskSummary | null
  faded: boolean
  /** It waits for a person, or a card under it does. */
  attention: boolean
}

export interface SubtaskBlock {
  rows: SubtaskRow[]
  more: number
  summary: SubtaskSummary | null
}

function toRow(cards: readonly ServeCardView[], statuses: readonly ServeStatusView[], card: ServeCardView, faded: ReadonlySet<string>): SubtaskRow {
  return {
    card,
    category: statuses.find(status => status.id === card.statusId)?.category ?? null,
    own: subtaskSummary(cards, statuses, card.id),
    faded: faded.has(card.id),
    attention: card.waitingFor === 'human' || waitsBelow(cards, card.id),
  }
}

/** A row for every direct sub-task of `cardId`, in board order: the dialog lists all of them. */
export function subtaskRowsOf(cards: readonly ServeCardView[], statuses: readonly ServeStatusView[], cardId: string): SubtaskRow[] {
  return childrenOf(cards, statuses, cardId).map(card => toRow(cards, statuses, card, new Set()))
}

/** What a parent's card draws inside itself, or `null` for a card with no sub-tasks. */
export function subtaskBlock(
  cards: readonly ServeCardView[],
  statuses: readonly ServeStatusView[],
  cardId: string,
  faded: ReadonlySet<string>,
): SubtaskBlock | null {
  const { rows, more } = subtaskRows(cards, statuses, cardId)
  if (rows.length === 0) {
    return null
  }
  return { rows: rows.map(card => toRow(cards, statuses, card, faded)), more, summary: subtaskSummary(cards, statuses, cardId) }
}

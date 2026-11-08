import type { ServeCardView, ServeStatusView } from '../views'

/**
 * Sub-tasks, as the board lays them out. A card whose `parentIssueId` names a
 * card that is loaded is a **child**; one whose parent is not loaded is an
 * **orphan** and is drawn like any top-level card. Everything here is a pure
 * function of the loaded cards and columns, so it is tested with no DOM.
 *
 * Two modes. `cards` draws every card in its own column, children marked as
 * such. `inside` folds a child into its parent's card as a row while it sits
 * in the parent's column (and a grandchild folded into that row shows as a row
 * one level deeper); in any other column a child is drawn as a card of its
 * own, marked as a sub-task. A card is therefore drawn exactly once: as a card,
 * or as a row in the card it is folded under.
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

/** Whether `card` is folded into its parent in `inside` mode: it is a child and sits in its parent's column. */
export function isFolded(cards: readonly ServeCardView[], card: ServeCardView): boolean {
  return isChild(cards, card) && parentOf(cards, card)?.statusId === card.statusId
}

/** The cards drawn in the columns: every card in `cards` mode, those that are not folded in `inside` mode. */
export function drawnCards(cards: readonly ServeCardView[], mode: SubtaskMode): ServeCardView[] {
  return mode === 'cards' ? [...cards] : cards.filter(card => !isFolded(cards, card))
}

export interface FoldedCard {
  card: ServeCardView
  /** 1 for a direct child of the card, 2 for a grandchild folded into it, and so on. */
  depth: number
}

/** Every card folded under `cardId`, depth first: each folded child in board order, then at once its own folded cards. */
export function foldedUnder(cards: readonly ServeCardView[], statuses: readonly ServeStatusView[], cardId: string): FoldedCard[] {
  const found: FoldedCard[] = []
  const seen = new Set([cardId])
  const walk = (id: string, depth: number): void => {
    for (const child of childrenOf(cards, statuses, id)) {
      if (!seen.has(child.id) && isFolded(cards, child)) {
        seen.add(child.id)
        found.push({ card: child, depth })
        walk(child.id, depth + 1)
      }
    }
  }
  walk(cardId, 1)
  return found
}

/** The cards folded under `cardId` through folded links, at any depth, each once. */
export function foldedBelow(cards: readonly ServeCardView[], cardId: string): ServeCardView[] {
  const found: ServeCardView[] = []
  const seen = new Set([cardId])
  const queue = [cardId]
  while (queue.length > 0) {
    const id = queue.shift()!
    for (const card of cards) {
      if (card.parentIssueId === id && !seen.has(card.id) && isFolded(cards, card)) {
        seen.add(card.id)
        found.push(card)
        queue.push(card.id)
      }
    }
  }
  return found
}

/** The rows a card lists for the cards folded under it, at most `MAX_SUBTASK_ROWS` counting grandchildren, and how many more there are. */
export function subtaskRows(cards: readonly ServeCardView[], statuses: readonly ServeStatusView[], cardId: string): { rows: FoldedCard[], more: number } {
  const all = foldedUnder(cards, statuses, cardId)
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

/** Whether any card folded under `cardId` waits for a person; a card drawn on its own shows its own pill. */
export function waitsBelow(cards: readonly ServeCardView[], cardId: string): boolean {
  return foldedBelow(cards, cardId).some(card => card.waitingFor === 'human')
}

/** Whether any card folded under `cardId` has a run going; a card drawn on its own shows its own dot. */
export function runsBelow(cards: readonly ServeCardView[], cardId: string): boolean {
  return foldedBelow(cards, cardId).some(card => card.activeRun?.state === 'running')
}

export interface FamilyView {
  /** The ids of the cards drawn in columns. */
  drawn: Set<string>
  /** Rows folded into a drawn card, at any depth, that do not match: drawn at half opacity. */
  faded: Set<string>
  /** The toolbar's count: the cards drawn plus the sub-tasks under them that match. */
  count: number
}

/**
 * What a filter shows. In `cards` mode, each card on its own. In `inside` mode a
 * card goes together with the rows folded into it: it is drawn when it, or any
 * card folded under it at any depth, matches, and the rows that do not match
 * (nor hold a match) are faded rather than hidden. A sub-task drawn as a card
 * of its own is filtered as any other card.
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
    const below = foldedBelow(cards, top.id)
    const matching = new Set(below.filter(matches).map(card => card.id))
    if (!matches(top) && matching.size === 0) {
      continue
    }
    drawn.add(top.id)
    count += 1 + matching.size
    for (const row of below) {
      const holdsMatch = matching.has(row.id) || foldedBelow(cards, row.id).some(card => matching.has(card.id))
      if (!holdsMatch) {
        faded.add(row.id)
      }
    }
  }
  return { drawn, faded, count }
}

export interface SubtaskRow {
  card: ServeCardView
  /** The category of the column the sub-task is in. */
  category: ServeStatusView['category'] | null
  /** 1 for a direct sub-task, 2 for one folded into that row, and so on. */
  depth: number
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

function toRow(cards: readonly ServeCardView[], statuses: readonly ServeStatusView[], card: ServeCardView, depth: number, faded: ReadonlySet<string>): SubtaskRow {
  return {
    card,
    depth,
    category: statuses.find(status => status.id === card.statusId)?.category ?? null,
    own: subtaskSummary(cards, statuses, card.id),
    faded: faded.has(card.id),
    attention: card.waitingFor === 'human' || waitsBelow(cards, card.id),
  }
}

/** A row for every direct sub-task of `cardId`, in board order: the dialog lists all of them. */
export function subtaskRowsOf(cards: readonly ServeCardView[], statuses: readonly ServeStatusView[], cardId: string): SubtaskRow[] {
  return childrenOf(cards, statuses, cardId).map(card => toRow(cards, statuses, card, 1, new Set()))
}

/** What a card draws inside itself for the cards folded under it, or `null` when none is. */
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
  return { rows: rows.map(row => toRow(cards, statuses, row.card, row.depth, faded)), more, summary: subtaskSummary(cards, statuses, cardId) }
}

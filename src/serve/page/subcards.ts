import type { ServeCardView, ServeStatusView } from '../views'

export interface SubcardSummary { total: number, done: number }

/** The sub-cards of `cardId`, in board order (status order, then `order`). */
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
export function subcardSummary(cards: readonly ServeCardView[], statuses: readonly ServeStatusView[], cardId: string): SubcardSummary | null {
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

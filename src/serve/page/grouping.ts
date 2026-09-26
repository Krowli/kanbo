import type { ServeCardView, ServeStatusView } from '../views'

/**
 * The board as the page lays it out: one column per status, in the order the
 * server lists them, each with its cards in board order.
 *
 * Canceled is a resting place, not a stage, so it earns a column only once a
 * card is in it; and a card pointing at a status the board no longer lists is
 * shown in a column of its own rather than dropped.
 */

export interface BoardColumn {
  /** The status id, or the id a card points at that names no status. */
  id: string
  name: string
  /** `null` for the column of cards whose status is gone. */
  status: ServeStatusView | null
  cards: ServeCardView[]
}

export function groupBoard(statuses: readonly ServeStatusView[], cards: readonly ServeCardView[]): BoardColumn[] {
  const usedStatusIds = new Set(cards.map(card => card.statusId))
  const columns: BoardColumn[] = statuses
    .filter(status => status.category !== 'canceled' || usedStatusIds.has(status.id))
    .map(status => ({ id: status.id, name: status.name, status, cards: [] }))
  const byId = new Map(columns.map(column => [column.id, column]))
  const known = new Set(statuses.map(status => status.id))

  for (const card of cards) {
    const id = card.statusId ?? ''
    let column = byId.get(id)
    if (!column && !known.has(id)) {
      column = { id, name: card.statusId ?? 'No status', status: null, cards: [] }
      byId.set(id, column)
      columns.push(column)
    }
    column?.cards.push(card)
  }
  return columns
}

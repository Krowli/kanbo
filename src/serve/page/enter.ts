import type { ServeCardView } from '../views'

/**
 * What changed for a card since the board was last drawn, so that only that
 * moves: every render builds the board again, and a motion set on every card
 * would replay on every poll.
 *
 * `previous` is the last render's placements, `null` before the first one —
 * loading the page moves nothing.
 */

export interface Placement {
  statusId: string | null
  waiting: boolean
}

/** Where each card is, and whether it waits for a person, as the next render compares against. */
export function placementsOf(cards: readonly ServeCardView[]): Map<string, Placement> {
  return new Map(cards.map(card => [card.id, { statusId: card.statusId, waiting: card.waitingFor === 'human' }]))
}

/** `new` for a card the last render did not have, `moved` for one that was in another column, else nothing. */
export function enterOf(previous: ReadonlyMap<string, Placement> | null, card: Pick<ServeCardView, 'id' | 'statusId'>): 'new' | 'moved' | null {
  if (previous === null) {
    return null
  }
  const before = previous.get(card.id)
  if (!before) {
    return 'new'
  }
  return before.statusId === card.statusId ? null : 'moved'
}

/** Whether a card waits for a person now and did not at the last render: its badge calls once. */
export function startsWaiting(previous: ReadonlyMap<string, Placement> | null, card: Pick<ServeCardView, 'id' | 'waitingFor'>): boolean {
  return previous !== null && card.waitingFor === 'human' && previous.get(card.id)?.waiting !== true
}

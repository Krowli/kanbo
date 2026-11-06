import type { Issue } from '../sqlite/schema'
import type { ColumnEntry } from './column-entries'

/** One stretch a card spent in one column: from the move in until the move out, `to` `null` while it is still there. */
export interface CardStretch {
  statusId: string | null
  from: number
  to: number | null
}

/**
 * A card's columns over time, oldest first, from its creation on: the column
 * it was created in, then one stretch per move. A card created before 0.5.0
 * carries no entry for its creation; one created since carries `null → column`
 * at its creation, which leaves a stretch of no length in no column.
 *
 * The feed lists moves by time and then by change id, and a change id is
 * random, so two moves of one card in the same second can come back in either
 * order. Within one second the moves are put back in the order they chain —
 * each leaves the column the one before it entered — which is the order they
 * were made in (ruling R012-5). Moves that do not chain keep the feed's order.
 */
export function buildCardTimeline(card: Pick<Issue, 'statusId' | 'createdAt'>, entries: readonly ColumnEntry[]): CardStretch[] {
  const ordered = chainSameSecond(entries.toSorted((left, right) => left.at - right.at || (left.changeId < right.changeId ? -1 : left.changeId > right.changeId ? 1 : 0)))
  const stretches: CardStretch[] = []
  // Where the first move left from (no column, for a 0.5.0 creation), or where the card is now if it never moved.
  const first = ordered[0]
  let current: CardStretch = { statusId: first ? first.fromStatusId : card.statusId, from: card.createdAt, to: null }
  for (const entry of ordered) {
    stretches.push({ ...current, to: entry.at })
    current = { statusId: entry.toStatusId, from: entry.at, to: null }
  }
  stretches.push(current)
  return stretches
}

/** The column the card was in at `at` — a move at `at` has already happened — or `undefined` before the card existed. */
export function statusAt(stretches: readonly CardStretch[], at: number): string | null | undefined {
  return stretches.find(stretch => stretch.from <= at && (stretch.to === null || at < stretch.to))?.statusId
}

function chainSameSecond(entries: readonly ColumnEntry[]): ColumnEntry[] {
  const ordered: ColumnEntry[] = []
  let start = 0
  while (start < entries.length) {
    let end = start
    while (end < entries.length && entries[end]!.at === entries[start]!.at) {
      end++
    }
    const group = entries.slice(start, end)
    const previous = ordered.at(-1)
    // The first move of a card's history leaves the column no other move of its second entered.
    let current = previous ? previous.toStatusId : headOf(group)?.fromStatusId
    while (group.length > 0) {
      let next = group.findIndex(entry => entry.fromStatusId === current)
      if (next < 0) {
        // The chain is broken (a move to no column is not in the feed): start again from the head of what is left.
        next = Math.max(group.findIndex(entry => entry === headOf(group)), 0)
      }
      const [picked] = group.splice(next, 1)
      ordered.push(picked!)
      current = picked!.toStatusId
    }
    start = end
  }
  return ordered
}

/** The move nothing else in the group feeds into. */
function headOf(group: readonly ColumnEntry[]): ColumnEntry | undefined {
  return group.find(entry => !group.some(other => other !== entry && other.toStatusId === entry.fromStatusId))
}

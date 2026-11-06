import { describe, expect, it } from 'vitest'

import { buildCardTimeline, statusAt } from './card-timeline'
import type { ColumnEntry } from './column-entries'

function move(changeId: string, fromStatusId: string | null, toStatusId: string, at: number): ColumnEntry {
  return { changeId, issueId: 'WOR-001', workspaceId: 'workspace', fromStatusId, toStatusId, actorKind: 'agent', actorId: 'claude', at }
}

describe('a card\'s timeline', () => {
  it('starts in the column the card was created in and adds a stretch per move', () => {
    const stretches = buildCardTimeline({ statusId: 'done', createdAt: 100 }, [
      move('change-b', 'progress', 'done', 300),
      move('change-a', 'todo', 'progress', 150),
    ])

    expect(stretches).toEqual([
      { statusId: 'todo', from: 100, to: 150 },
      { statusId: 'progress', from: 150, to: 300 },
      { statusId: 'done', from: 300, to: null },
    ])
  })

  it('is the column the card has now, from its creation, when it never moved', () => {
    expect(buildCardTimeline({ statusId: 'progress', createdAt: 100 }, [])).toEqual([{ statusId: 'progress', from: 100, to: null }])
  })

  it('reads a creation recorded as an entry from no column (0.5.0) like one that was not', () => {
    const stretches = buildCardTimeline({ statusId: 'progress', createdAt: 100 }, [move('change-a', null, 'todo', 100), move('change-b', 'todo', 'progress', 150)])

    expect(stretches).toEqual([
      { statusId: null, from: 100, to: 100 },
      { statusId: 'todo', from: 100, to: 150 },
      { statusId: 'progress', from: 150, to: null },
    ])
    expect(statusAt(stretches, 100)).toBe('todo')
  })

  it('puts two moves of the same second back in the order they chain', () => {
    // The feed orders by change id inside a second, and ids are random: here
    // the second move comes first.
    const stretches = buildCardTimeline({ statusId: 'review', createdAt: 100 }, [
      move('change-a', 'progress', 'review', 200),
      move('change-b', 'todo', 'progress', 200),
    ])

    expect(stretches).toEqual([
      { statusId: 'todo', from: 100, to: 200 },
      { statusId: 'progress', from: 200, to: 200 },
      { statusId: 'review', from: 200, to: null },
    ])
  })

  it('reads the column at a moment, a move at that moment already made, and nothing before the card existed', () => {
    const stretches = buildCardTimeline({ statusId: 'done', createdAt: 100 }, [move('change-a', 'todo', 'done', 200)])

    expect(statusAt(stretches, 99)).toBeUndefined()
    expect(statusAt(stretches, 100)).toBe('todo')
    expect(statusAt(stretches, 199)).toBe('todo')
    expect(statusAt(stretches, 200)).toBe('done')
  })

  it('ends in the column the card is in after a move to no column the feed does not hold', () => {
    // A→B, a hidden move out of every column, then none→C and C→D in one second, given in either order.
    const group = [move('y', null, 'C', 200), move('z', 'C', 'D', 200)]
    for (const sameSecond of [group, group.toReversed()]) {
      const stretches = buildCardTimeline({ statusId: 'D', createdAt: 50 }, [move('a', 'A', 'B', 100), ...sameSecond])

      expect(stretches.map(stretch => stretch.statusId)).toEqual(['A', 'B', 'C', 'D'])
    }
  })

  it('gives the same timeline for a same-second group in any input order', () => {
    const group = [move('a', 'A', 'B', 200), move('b', 'B', 'C', 200), move('c', 'C', 'D', 200), move('d', 'D', 'E', 200)]
    const expected = buildCardTimeline({ statusId: 'E', createdAt: 50 }, group)
    for (const shuffled of [group.toReversed(), [group[2]!, group[0]!, group[3]!, group[1]!], [group[3]!, group[1]!, group[2]!, group[0]!]]) {
      expect(buildCardTimeline({ statusId: 'E', createdAt: 50 }, shuffled)).toEqual(expected)
    }
    expect(expected.map(stretch => stretch.statusId)).toEqual(['A', 'B', 'C', 'D', 'E'])
  })
})

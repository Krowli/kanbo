import { describe, expect, it } from 'vitest'

import { columnBadge, columnRules, countByStatus } from './column-badges'
import { cardFixture, statusFixture } from './fixtures'

const review = statusFixture({ id: 'review', name: 'In Review' })
const done = statusFixture({ id: 'done', name: 'Done', category: 'completed' })

describe('columnBadge', () => {
  it('is the plain count of the cards shown while the column has no limit', () => {
    expect(columnBadge(done, 2, 5)).toEqual({ text: '2', full: false })
    expect(columnBadge(null, 3, 3)).toEqual({ text: '3', full: false })
  })

  it('is n/limit with a limit, n counting every card in the column, filtered or not', () => {
    const limited = statusFixture({ id: 'doing', name: 'Doing', wipLimit: 3 })
    expect(columnBadge(limited, 0, 2)).toEqual({ text: '2/3', full: false })
  })

  it('turns warning at the limit and over it', () => {
    const limited = statusFixture({ id: 'doing', name: 'Doing', wipLimit: 3 })
    expect(columnBadge(limited, 3, 3).full).toBe(true)
    expect(columnBadge(limited, 1, 4)).toEqual({ text: '4/3', full: true })
  })
})

describe('columnRules', () => {
  it('is null for a column with no rules, and names each rule in words otherwise', () => {
    expect(columnRules(review, [review, done])).toBeNull()
    const guarded = statusFixture({ id: 'done', name: 'Done', allowedFrom: ['review'], wipLimit: 1, entryRules: ['checklist_complete', 'approved'] })
    expect(columnRules(guarded, [review, guarded])).toBe([
      'Accepts cards only from In Review',
      'Limit: 1 card',
      'A card needs: every checklist item checked; a person\'s approval',
    ].join('\n'))
  })

  it('says a column that takes cards from no other column is a person\'s, and a limit in the plural', () => {
    const closed = statusFixture({ id: 'x', name: 'X', allowedFrom: [], wipLimit: 3 })
    expect(columnRules(closed, [closed])).toBe('Only a person puts a card here\nLimit: 3 cards')
  })

  it('names a source column that no longer exists by its id', () => {
    const guarded = statusFixture({ id: 'done', name: 'Done', allowedFrom: ['gone', 'review'] })
    expect(columnRules(guarded, [review, guarded])).toBe('Accepts cards only from gone, In Review')
  })
})

describe('countByStatus', () => {
  const cards = [
    cardFixture({ id: 'A', statusId: 'todo' }),
    cardFixture({ id: 'B', statusId: 'doing', parentIssueId: 'A' }),
    cardFixture({ id: 'C', statusId: 'doing' }),
    cardFixture({ id: 'D', statusId: null }),
  ]

  it('counts a sub-task in its own column, whichever column its parent is in', () => {
    expect([...countByStatus(cards)]).toEqual([['todo', 1], ['doing', 2]])
  })

  it('counts only the cards the filter lets through', () => {
    expect([...countByStatus(cards, card => card.id !== 'C')]).toEqual([['todo', 1], ['doing', 1]])
  })
})

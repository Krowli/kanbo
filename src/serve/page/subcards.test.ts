import { describe, expect, it } from 'vitest'

import { cardFixture, statusFixture } from './fixtures'
import { childrenOf, parentOf, subcardSummary } from './subcards'

const statuses = [
  statusFixture({ id: 'todo', name: 'To Do', order: 0 }),
  statusFixture({ id: 'doing', name: 'Doing', order: 1, category: 'started' }),
  statusFixture({ id: 'done', name: 'Done', order: 2, category: 'completed' }),
  statusFixture({ id: 'no', name: 'Canceled', order: 3, category: 'canceled' }),
]
const parent = cardFixture({ id: 'WOR-001' })
const part = (id: string, statusId: string, order = 0) => cardFixture({ id, statusId, order, parentIssueId: 'WOR-001' })

describe('childrenOf', () => {
  it('lists the sub-cards in status order, then card order', () => {
    const cards = [parent, part('WOR-004', 'done'), part('WOR-003', 'todo', 2), part('WOR-002', 'todo', 1), cardFixture({ id: 'WOR-009' })]
    expect(childrenOf(cards, statuses, 'WOR-001').map(card => card.id)).toEqual(['WOR-002', 'WOR-003', 'WOR-004'])
  })

  it('never lists a card as its own child', () => {
    const own = cardFixture({ id: 'WOR-001', parentIssueId: 'WOR-001' })
    expect(childrenOf([own], statuses, 'WOR-001')).toEqual([])
    expect(parentOf([own], own)).toBeNull()
  })
})

describe('subcardSummary', () => {
  it('counts only completed ones as done', () => {
    const cards = [parent, part('WOR-002', 'done'), part('WOR-003', 'doing'), part('WOR-004', 'done')]
    expect(subcardSummary(cards, statuses, 'WOR-001')).toEqual({ total: 3, done: 2 })
  })

  it('leaves canceled ones out of both numbers', () => {
    const cards = [parent, part('WOR-002', 'done'), part('WOR-003', 'no')]
    expect(subcardSummary(cards, statuses, 'WOR-001')).toEqual({ total: 1, done: 1 })
  })

  it('is null without sub-cards, or with only canceled ones', () => {
    expect(subcardSummary([parent], statuses, 'WOR-001')).toBeNull()
    expect(subcardSummary([parent, part('WOR-002', 'no')], statuses, 'WOR-001')).toBeNull()
  })
})

describe('parentOf', () => {
  it('finds the parent, and is null for none or one not on the board', () => {
    const child = part('WOR-002', 'todo')
    expect(parentOf([parent, child], child)?.id).toBe('WOR-001')
    expect(parentOf([parent], parent)).toBeNull()
    expect(parentOf([child], child)).toBeNull()
  })
})

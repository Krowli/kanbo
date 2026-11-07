import { describe, expect, it } from 'vitest'

import type { ServeCardView } from '../views'
import { cardFixture, statusFixture } from './fixtures'
import { childrenOf, descendantsOf, drawnCards, familyView, isChild, parentOf, subtaskBlock, subtaskRows, subtaskSummary, waitsBelow } from './subtasks'

const statuses = [
  statusFixture({ id: 'todo', name: 'To Do', order: 0 }),
  statusFixture({ id: 'doing', name: 'Doing', order: 1, category: 'started' }),
  statusFixture({ id: 'done', name: 'Done', order: 2, category: 'completed' }),
  statusFixture({ id: 'no', name: 'Canceled', order: 3, category: 'canceled' }),
]
const parent = cardFixture({ id: 'WOR-001' })
const part = (id: string, statusId: string, order = 0, parentId = 'WOR-001') => cardFixture({ id, statusId, order, parentIssueId: parentId })
const running: ServeCardView['activeRun'] = { id: 'run', agentId: null, agentName: 'claude', state: 'running', branch: null, executionMode: 'main', chatSessionId: null, startedAt: 0 }

describe('childrenOf', () => {
  it('lists the sub-tasks in status order, then card order', () => {
    const cards = [parent, part('WOR-004', 'done'), part('WOR-003', 'todo', 2), part('WOR-002', 'todo', 1), cardFixture({ id: 'WOR-009' })]
    expect(childrenOf(cards, statuses, 'WOR-001').map(card => card.id)).toEqual(['WOR-002', 'WOR-003', 'WOR-004'])
  })

  it('never lists a card as its own child', () => {
    const own = cardFixture({ id: 'WOR-001', parentIssueId: 'WOR-001' })
    expect(childrenOf([own], statuses, 'WOR-001')).toEqual([])
    expect(parentOf([own], own)).toBeNull()
  })
})

describe('subtaskSummary', () => {
  it('counts only completed ones as done', () => {
    const cards = [parent, part('WOR-002', 'done'), part('WOR-003', 'doing'), part('WOR-004', 'done')]
    expect(subtaskSummary(cards, statuses, 'WOR-001')).toEqual({ total: 3, done: 2 })
  })

  it('leaves canceled ones out of both numbers', () => {
    const cards = [parent, part('WOR-002', 'done'), part('WOR-003', 'no')]
    expect(subtaskSummary(cards, statuses, 'WOR-001')).toEqual({ total: 1, done: 1 })
  })

  it('is null without sub-tasks, or with only canceled ones', () => {
    expect(subtaskSummary([parent], statuses, 'WOR-001')).toBeNull()
    expect(subtaskSummary([parent, part('WOR-002', 'no')], statuses, 'WOR-001')).toBeNull()
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

describe('which cards are drawn', () => {
  const orphan = part('WOR-010', 'todo', 0, 'WOR-404')
  const cards = [parent, part('WOR-002', 'todo'), part('WOR-003', 'doing', 0, 'WOR-002'), orphan]

  it('draws only the cards that are not sub-tasks in inside mode, an orphan among them', () => {
    expect(drawnCards(cards, 'inside').map(card => card.id)).toEqual(['WOR-001', 'WOR-010'])
  })

  it('draws every card in cards mode', () => {
    expect(drawnCards(cards, 'cards').map(card => card.id)).toEqual(['WOR-001', 'WOR-002', 'WOR-003', 'WOR-010'])
  })

  it('takes a card whose parent is not loaded for an orphan, and a loop of parents for top-level cards', () => {
    expect(isChild(cards, orphan)).toBe(false)
    const a = cardFixture({ id: 'A', parentIssueId: 'B' })
    const b = cardFixture({ id: 'B', parentIssueId: 'A' })
    expect(drawnCards([a, b], 'inside').map(card => card.id)).toEqual(['A', 'B'])
  })
})

describe('subtaskRows', () => {
  it('lists the direct children only, in column then card order', () => {
    const cards = [parent, part('WOR-003', 'doing'), part('WOR-002', 'todo'), part('WOR-004', 'done', 0, 'WOR-002')]
    const { rows, more } = subtaskRows(cards, statuses, 'WOR-001')
    expect(rows.map(card => card.id)).toEqual(['WOR-002', 'WOR-003'])
    expect(more).toBe(0)
  })

  it('shows at most five rows and says how many more', () => {
    const cards = [parent, ...[1, 2, 3, 4, 5, 6, 7].map(n => part(`WOR-10${n}`, 'todo', n))]
    const { rows, more } = subtaskRows(cards, statuses, 'WOR-001')
    expect(rows.map(card => card.id)).toEqual(['WOR-101', 'WOR-102', 'WOR-103', 'WOR-104', 'WOR-105'])
    expect(more).toBe(2)
  })
})

describe('waiting and running below a card', () => {
  const cards = [parent, part('WOR-002', 'todo'), { ...part('WOR-003', 'doing', 0, 'WOR-002'), waitingFor: 'human' as const }, { ...part('WOR-004', 'doing', 0, 'WOR-002'), activeRun: running }]

  it('finds a waiting sub-task at depth two', () => {
    expect(waitsBelow(cards, 'WOR-001')).toBe(true)
    expect(waitsBelow(cards, 'WOR-002')).toBe(true)
    expect(waitsBelow(cards, 'WOR-003')).toBe(false)
  })

  it('lists every descendant, once, even in a loop', () => {
    expect(descendantsOf(cards, 'WOR-001').map(card => card.id)).toEqual(['WOR-002', 'WOR-003', 'WOR-004'])
    const loop = [cardFixture({ id: 'A', parentIssueId: 'B' }), cardFixture({ id: 'B', parentIssueId: 'A' })]
    expect(descendantsOf(loop, 'A').map(card => card.id)).toEqual(['B'])
  })
})

describe('familyView', () => {
  const cards = [
    parent,
    part('WOR-002', 'todo'),
    part('WOR-003', 'doing', 1),
    cardFixture({ id: 'WOR-004', parentIssueId: 'WOR-003', waitingFor: 'human' }),
    cardFixture({ id: 'WOR-005', title: 'alone' }),
  ]
  const waiting = (card: ServeCardView) => card.waitingFor === 'human'

  it('matches everything when nothing filters: every card counts once', () => {
    const view = familyView(cards, 'inside', () => true)
    expect([...view.drawn]).toEqual(['WOR-001', 'WOR-005'])
    expect(view.faded.size).toBe(0)
    expect(view.count).toBe(5)
  })

  it('brings up the parent of a waiting sub-task two levels down, and fades what does not match inside it', () => {
    const view = familyView(cards, 'inside', waiting)
    expect([...view.drawn]).toEqual(['WOR-001'])
    expect([...view.faded]).toEqual(['WOR-002'])
    // WOR-003 does not wait itself but its own child does: it is not faded.
    expect(view.count).toBe(2)
  })

  it('draws a parent that matches by itself with its sub-tasks faded', () => {
    const view = familyView(cards, 'inside', card => card.id === 'WOR-001')
    expect([...view.drawn]).toEqual(['WOR-001'])
    expect([...view.faded].sort()).toEqual(['WOR-002', 'WOR-003'])
    expect(view.count).toBe(1)
  })

  it('filters card by card in cards mode', () => {
    const view = familyView(cards, 'cards', waiting)
    expect([...view.drawn]).toEqual(['WOR-004'])
    expect(view.faded.size).toBe(0)
    expect(view.count).toBe(1)
  })
})

describe('subtaskBlock', () => {
  const cards = [
    parent,
    part('WOR-002', 'todo'),
    { ...part('WOR-003', 'doing'), waitingFor: 'human' as const },
    part('WOR-004', 'done'),
    part('WOR-005', 'no'),
    part('WOR-006', 'todo', 0, 'WOR-002'),
    { ...part('WOR-007', 'doing', 0, 'WOR-006'), waitingFor: 'human' as const },
  ]

  it('is null for a card with no sub-tasks', () => {
    expect(subtaskBlock(cards, statuses, 'WOR-004', new Set())).toBeNull()
  })

  it('holds a row per direct child with its column category, and the parent progress without canceled ones', () => {
    const block = subtaskBlock(cards, statuses, 'WOR-001', new Set())!
    expect(block.rows.map(row => [row.card.id, row.category])).toEqual([['WOR-002', 'unstarted'], ['WOR-003', 'started'], ['WOR-004', 'completed'], ['WOR-005', 'canceled']])
    expect(block.summary).toEqual({ total: 3, done: 1 })
    expect(block.more).toBe(0)
  })

  it('gives a row its own n/m, marks a waiting sub-task and one with a waiting card below it, and fades what it is told to', () => {
    const block = subtaskBlock(cards, statuses, 'WOR-001', new Set(['WOR-004']))!
    const row = (id: string) => block.rows.find(item => item.card.id === id)!
    expect(row('WOR-002').own).toEqual({ total: 1, done: 0 })
    expect(row('WOR-003').own).toBeNull()
    expect(row('WOR-003').attention).toBe(true)
    expect(row('WOR-002').attention).toBe(true)
    expect(row('WOR-004').attention).toBe(false)
    expect(row('WOR-004').faded).toBe(true)
    expect(row('WOR-003').faded).toBe(false)
  })
})

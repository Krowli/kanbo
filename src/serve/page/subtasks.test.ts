import { describe, expect, it } from 'vitest'

import type { ServeCardView } from '../views'
import { cardFixture, statusFixture } from './fixtures'
import type { SubtaskBlock } from './subtasks'
import { childrenOf, descendantsOf, drawnCards, familyView, foldedBelow, isChild, isFolded, MAX_SUBTASK_ROWS, parentOf, runsBelow, subtaskBlock, subtaskRows, subtaskSummary, waitsBelow } from './subtasks'

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

  it('folds a sub-task in its parent column and draws the rest, an orphan among them', () => {
    expect(drawnCards(cards, 'inside').map(card => card.id)).toEqual(['WOR-001', 'WOR-003', 'WOR-010'])
    expect(isFolded(cards, cards[1]!)).toBe(true)
    expect(isFolded(cards, cards[2]!)).toBe(false)
  })

  it('draws every card in cards mode', () => {
    expect(drawnCards(cards, 'cards').map(card => card.id)).toEqual(['WOR-001', 'WOR-002', 'WOR-003', 'WOR-010'])
  })

  it('takes a card whose parent is not loaded for an orphan, and a loop of parents for top-level cards', () => {
    expect(isChild(cards, orphan)).toBe(false)
    expect(isFolded(cards, orphan)).toBe(false)
    const a = cardFixture({ id: 'A', parentIssueId: 'B' })
    const b = cardFixture({ id: 'B', parentIssueId: 'A' })
    expect(drawnCards([a, b], 'inside').map(card => card.id)).toEqual(['A', 'B'])
  })

  it('moves a sub-task out of its parent when it changes column and back in when it returns', () => {
    const out = [parent, part('WOR-002', 'doing')]
    expect(drawnCards(out, 'inside').map(card => card.id)).toEqual(['WOR-001', 'WOR-002'])
    expect(subtaskBlock(out, statuses, 'WOR-001', new Set())).toBeNull()
    expect(subtaskSummary(out, statuses, 'WOR-001')).toEqual({ total: 1, done: 0 })
    const back = [parent, part('WOR-002', 'todo')]
    expect(drawnCards(back, 'inside').map(card => card.id)).toEqual(['WOR-001'])
    expect(subtaskBlock(back, statuses, 'WOR-001', new Set())!.rows.map(row => row.card.id)).toEqual(['WOR-002'])
  })

  it('folds a grandchild into its parent only when they share a column', () => {
    const together = [parent, part('B', 'todo'), part('C', 'todo', 0, 'B')]
    expect(drawnCards(together, 'inside').map(card => card.id)).toEqual(['WOR-001'])
    const apart = [parent, part('B', 'todo'), part('C', 'doing', 0, 'B')]
    expect(drawnCards(apart, 'inside').map(card => card.id)).toEqual(['WOR-001', 'C'])
  })

  it('draws every card exactly once, as a card or as a row of exactly one drawn card', () => {
    const board = [
      parent,
      part('B', 'todo', 1),
      part('C', 'todo', 0, 'B'),
      part('D', 'doing', 1, 'B'),
      part('E', 'doing', 0, 'D'),
      part('F', 'done', 0, 'D'),
      part('G', 'todo', 2),
      part('H', 'doing', 0, 'G'),
      part('I', 'todo', 0, 'H'),
      part('J', 'todo', 3),
      part('K', 'todo', 0, 'J'),
      part('L', 'doing', 0, 'K'),
      part('M', 'doing', 0, 'L'),
      cardFixture({ id: 'LOOP-A', parentIssueId: 'LOOP-B' }),
      cardFixture({ id: 'LOOP-B', parentIssueId: 'LOOP-A' }),
      part('ORPHAN', 'doing', 0, 'NOPE'),
      ...[1, 2, 3, 4, 5, 6, 7].map(n => part(`MANY-${n}`, 'todo', n, 'J')),
    ]
    const seen = new Map<string, number>()
    const note = (id: string) => seen.set(id, (seen.get(id) ?? 0) + 1)
    for (const card of drawnCards(board, 'inside')) {
      note(card.id)
      const { rows, more } = subtaskRows(board, statuses, card.id)
      rows.forEach(row => note(row.card.id))
      // "+N more" counts as shown: it stands for the rows past the limit.
      const rest = foldedBelow(board, card.id).filter(below => !rows.some(row => row.card.id === below.id))
      expect(rest).toHaveLength(more)
      rest.forEach(below => note(below.id))
    }
    expect([...seen.keys()].sort()).toEqual(board.map(card => card.id).sort())
    expect([...seen.values()].every(count => count === 1)).toBe(true)
  })
})

describe('subtaskRows', () => {
  it('lists the folded children only, in column then card order', () => {
    const cards = [parent, part('WOR-003', 'doing'), part('WOR-002', 'todo'), part('WOR-005', 'todo', 1), part('WOR-004', 'done', 0, 'WOR-002')]
    const { rows, more } = subtaskRows(cards, statuses, 'WOR-001')
    expect(rows.map(row => [row.card.id, row.depth])).toEqual([['WOR-002', 1], ['WOR-005', 1]])
    expect(more).toBe(0)
  })

  it('lists a grandchild in the same column right under its parent row', () => {
    const cards = [parent, part('B', 'todo', 0), part('C', 'todo', 0, 'B'), part('D', 'todo', 1), part('E', 'todo', 0, 'C')]
    const { rows } = subtaskRows(cards, statuses, 'WOR-001')
    expect(rows.map(row => [row.card.id, row.depth])).toEqual([['B', 1], ['C', 2], ['E', 3], ['D', 1]])
  })

  it('shows at most five rows and says how many more', () => {
    const cards = [parent, ...[1, 2, 3, 4, 5, 6, 7].map(n => part(`WOR-10${n}`, 'todo', n))]
    const { rows, more } = subtaskRows(cards, statuses, 'WOR-001')
    expect(rows.map(row => row.card.id)).toEqual(['WOR-101', 'WOR-102', 'WOR-103', 'WOR-104', 'WOR-105'])
    expect(more).toBe(2)
  })

  it('counts grandchild rows in the five', () => {
    const cards = [parent, part('B', 'todo', 0), part('B1', 'todo', 0, 'B'), part('B2', 'todo', 1, 'B'), part('B3', 'todo', 2, 'B'), part('C', 'todo', 1)]
    const { rows, more } = subtaskRows(cards, statuses, 'WOR-001')
    expect(rows).toHaveLength(MAX_SUBTASK_ROWS)
    expect(rows.map(row => row.card.id)).toEqual(['B', 'B1', 'B2', 'B3', 'C'])
    expect(more).toBe(0)
    const extra = subtaskRows([...cards, part('B4', 'todo', 3, 'B')], statuses, 'WOR-001')
    expect(extra.rows.map(row => row.card.id)).toEqual(['B', 'B1', 'B2', 'B3', 'B4'])
    expect(extra.more).toBe(1)
  })
})

describe('waiting and running below a card', () => {
  const folded = [parent, part('WOR-002', 'todo'), { ...part('WOR-003', 'todo', 0, 'WOR-002'), waitingFor: 'human' as const }, { ...part('WOR-004', 'todo', 0, 'WOR-002'), activeRun: running }]
  const apart = [parent, part('WOR-002', 'todo'), { ...part('WOR-003', 'doing', 0, 'WOR-002'), waitingFor: 'human' as const }, { ...part('WOR-004', 'doing', 0, 'WOR-002'), activeRun: running }]

  it('finds a waiting sub-task folded two levels down', () => {
    expect(waitsBelow(folded, 'WOR-001')).toBe(true)
    expect(waitsBelow(folded, 'WOR-002')).toBe(true)
    expect(waitsBelow(folded, 'WOR-003')).toBe(false)
    expect(runsBelow(folded, 'WOR-001')).toBe(true)
  })

  it('leaves a sub-task drawn on its own to its own pill and dot', () => {
    expect(waitsBelow(apart, 'WOR-001')).toBe(false)
    expect(waitsBelow(apart, 'WOR-002')).toBe(false)
    expect(runsBelow(apart, 'WOR-001')).toBe(false)
  })

  it('does not look through a card that is drawn on its own', () => {
    const cards = [parent, part('B', 'doing'), { ...part('C', 'doing', 0, 'B'), waitingFor: 'human' as const }]
    expect(waitsBelow(cards, 'WOR-001')).toBe(false)
    expect(waitsBelow(cards, 'B')).toBe(true)
  })

  it('lists every descendant, once, even in a loop', () => {
    expect(descendantsOf(apart, 'WOR-001').map(card => card.id)).toEqual(['WOR-002', 'WOR-003', 'WOR-004'])
    const loop = [cardFixture({ id: 'A', parentIssueId: 'B' }), cardFixture({ id: 'B', parentIssueId: 'A' })]
    expect(descendantsOf(loop, 'A').map(card => card.id)).toEqual(['B'])
    expect(foldedBelow(loop, 'A')).toEqual([])
  })
})

describe('familyView', () => {
  const cards = [
    parent,
    part('WOR-002', 'todo'),
    part('WOR-003', 'todo', 1),
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

  it('brings up the parent of a waiting row two levels down, and fades what does not match inside it', () => {
    const view = familyView(cards, 'inside', waiting)
    expect([...view.drawn]).toEqual(['WOR-001'])
    expect([...view.faded]).toEqual(['WOR-002'])
    // WOR-003 does not wait itself but the row under it does: it is not faded.
    expect(view.count).toBe(2)
  })

  it('draws a card that matches by itself with every row under it faded, at any depth', () => {
    const view = familyView(cards, 'inside', card => card.id === 'WOR-001')
    expect([...view.drawn]).toEqual(['WOR-001'])
    expect([...view.faded].sort()).toEqual(['WOR-002', 'WOR-003', 'WOR-004'])
    expect(view.count).toBe(1)
  })

  it('draws a sub-task that has its own card without its parent when only it matches', () => {
    const board = [parent, part('WOR-002', 'doing')]
    const view = familyView(board, 'inside', card => card.id === 'WOR-002')
    expect([...view.drawn]).toEqual(['WOR-002'])
    expect(view.count).toBe(1)
  })

  it('fades a folded row that does not match under a parent that does', () => {
    const board = [parent, part('WOR-002', 'todo')]
    const view = familyView(board, 'inside', card => card.id === 'WOR-001')
    expect([...view.drawn]).toEqual(['WOR-001'])
    expect([...view.faded]).toEqual(['WOR-002'])
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
    { ...part('WOR-007', 'todo', 0, 'WOR-006'), waitingFor: 'human' as const },
    part('WOR-008', 'todo', 5),
  ]
  const block: SubtaskBlock = subtaskBlock(cards, statuses, 'WOR-001', new Set(['WOR-008']))!

  it('is null for a card with no sub-tasks', () => {
    expect(subtaskBlock(cards, statuses, 'WOR-004', new Set())).toBeNull()
  })

  it('holds a row for each folded card with its depth and column category, and the progress over all children without canceled ones', () => {
    expect(block.rows.map(row => [row.card.id, row.depth, row.category])).toEqual([
      ['WOR-002', 1, 'unstarted'],
      ['WOR-006', 2, 'unstarted'],
      ['WOR-007', 3, 'unstarted'],
      ['WOR-008', 1, 'unstarted'],
    ])
    expect(block.summary).toEqual({ total: 4, done: 1 })
    expect(block.more).toBe(0)
  })

  it('gives a row its own n/m, marks a row with a waiting card below it, and fades what it is told to', () => {
    const row = (id: string) => block.rows.find(item => item.card.id === id)!
    expect(row('WOR-002').own).toEqual({ total: 1, done: 0 })
    expect(row('WOR-007').own).toBeNull()
    expect(row('WOR-007').attention).toBe(true)
    expect(row('WOR-002').attention).toBe(true)
    expect(row('WOR-008').attention).toBe(false)
    expect(row('WOR-008').faded).toBe(true)
    expect(row('WOR-002').faded).toBe(false)
  })
})

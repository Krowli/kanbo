import { describe, expect, it } from 'vitest'

import { cardFixture, statusFixture } from './fixtures'
import { groupBoard, newCardStatus } from './grouping'

const STATUSES = [
  statusFixture({ id: 'todo', name: 'Todo' }),
  statusFixture({ id: 'doing', name: 'In Progress', category: 'started' }),
  statusFixture({ id: 'canceled', name: 'Canceled', category: 'canceled' }),
]

describe('groupBoard', () => {
  it('lays the columns out in board order with their cards, and hides an empty Canceled', () => {
    const columns = groupBoard(STATUSES, [
      cardFixture({ id: 'WOR-002', statusId: 'doing' }),
      cardFixture({ id: 'WOR-001', statusId: 'todo' }),
      cardFixture({ id: 'WOR-003', statusId: 'doing' }),
    ])
    expect(columns.map(column => [column.name, column.cards.map(card => card.id)])).toEqual([
      ['Todo', ['WOR-001']],
      ['In Progress', ['WOR-002', 'WOR-003']],
    ])
  })

  it('shows Canceled once a card is in it', () => {
    const columns = groupBoard(STATUSES, [cardFixture({ id: 'WOR-001', statusId: 'canceled' })])
    expect(columns.map(column => column.name)).toEqual(['Todo', 'In Progress', 'Canceled'])
  })

  it('keeps a card whose status is gone in a column of its own', () => {
    const columns = groupBoard(STATUSES, [cardFixture({ id: 'WOR-001', statusId: 'deleted-status' })])
    expect(columns.at(-1)).toMatchObject({ id: 'deleted-status', status: null, cards: [{ id: 'WOR-001' }] })
  })
})

describe('newCardStatus', () => {
  it('is the To Do column, however it is spelled', () => {
    expect(newCardStatus(STATUSES)?.id).toBe('todo')
    expect(newCardStatus([statusFixture({ id: 'a', name: 'Backlog', category: 'backlog' }), statusFixture({ id: 'b', name: 'To do' })])?.id).toBe('b')
  })

  it('falls back to the first unstarted column, then to the first one that is not canceled', () => {
    expect(newCardStatus([statusFixture({ id: 'a', name: 'Ready' }), statusFixture({ id: 'b', name: 'Doing', category: 'started' })])?.id).toBe('a')
    expect(newCardStatus([statusFixture({ id: 'x', name: 'Gone', category: 'canceled' }), statusFixture({ id: 'y', name: 'Doing', category: 'started' })])?.id).toBe('y')
    expect(newCardStatus([])).toBeNull()
  })
})

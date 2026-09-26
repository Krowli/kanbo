import { describe, expect, it } from 'vitest'

import { cardFixture, statusFixture } from './fixtures'
import { groupBoard } from './grouping'

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

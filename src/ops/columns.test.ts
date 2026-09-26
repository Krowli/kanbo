import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { BoardStore } from '../board-store'
import { DEFAULT_STATUSES } from '../domain/status-name'
import type { TestBoardStore } from '../testing/board-stores'
import { BOARD_STORE_FACTORIES } from '../testing/board-stores'
import { readChangeSeq } from './change-seq'
import { addStandardColumns, ensureDefaultColumns, listColumns } from './columns'

describe.each(BOARD_STORE_FACTORIES)('board columns on $name', (factory) => {
  let board: TestBoardStore
  let store: BoardStore

  beforeEach(async () => {
    board = await factory.open([{ id: 'workspace' }])
    store = board.store
  })

  afterEach(async () => {
    await board.dispose()
  })

  it('seeds the six standard columns, In Review fourth, each with its description', async () => {
    await ensureDefaultColumns(store, 'workspace')

    const columns = await listColumns(store, 'workspace')
    expect(columns.map(column => column.name)).toEqual(['Backlog', 'To Do', 'In Progress', 'In Review', 'Done', 'Canceled'])
    expect(columns[3]).toMatchObject({ name: 'In Review', category: 'started' })
    expect(columns.map(column => column.description)).toEqual(DEFAULT_STATUSES.map(status => status.description))
    expect(columns.map(column => column.order)).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('seeds nothing on a board that already has columns', async () => {
    await store.statuses.create({ id: 'mine', workspaceId: 'workspace', name: 'Mine', order: 0 })

    await ensureDefaultColumns(store, 'workspace')

    expect((await listColumns(store, 'workspace')).map(column => column.name)).toEqual(['Mine'])
  })

  it('adds only the missing standard columns, each after the standard column before it, keeping the custom order', async () => {
    await store.statuses.create({ id: 'backlog', workspaceId: 'workspace', name: 'Backlog', order: 0 })
    await store.statuses.create({ id: 'mine', workspaceId: 'workspace', name: 'Triage mine', order: 1 })
    await store.statuses.create({ id: 'done', workspaceId: 'workspace', name: 'Done', order: 2 })

    const result = await addStandardColumns(store, 'workspace')

    expect(result.added).toEqual(['To Do', 'In Progress', 'In Review', 'Canceled'])
    expect(result.statuses.map(column => column.name)).toEqual([
      'Backlog',
      'To Do',
      'In Progress',
      'In Review',
      'Triage mine',
      'Done',
      'Canceled',
    ])
    expect(result.statuses.map(column => column.order)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(result.statuses.find(column => column.name === 'To Do')?.description)
      .toBe(DEFAULT_STATUSES[1].description)
  })

  it('writes nothing the second time, so the board version stays where it was', async () => {
    await addStandardColumns(store, 'workspace')
    const afterFirst = await readChangeSeq(store)
    const before = await listColumns(store, 'workspace')

    const result = await addStandardColumns(store, 'workspace')

    expect(result.added).toEqual([])
    expect(result.statuses).toEqual(before)
    expect(await readChangeSeq(store)).toBe(afterFirst)
  })
})

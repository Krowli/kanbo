import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { BoardStore } from '../board-store'
import type { TestBoardStore } from '../testing/board-stores'
import { BOARD_STORE_FACTORIES } from '../testing/board-stores'
import { readChangeSeq, runBoardWrite } from './change-seq'

describe.each(BOARD_STORE_FACTORIES)('board change sequence on $name', (factory) => {
  let board: TestBoardStore
  let store: BoardStore

  beforeEach(async () => {
    board = await factory.open([{ id: 'workspace' }])
    store = board.store
  })

  afterEach(async () => {
    await board.dispose()
  })

  it('bumps the sequence once per write transaction, however many rows it wrote', async () => {
    const before = await readChangeSeq(store)

    await runBoardWrite(store, async ({ tx }) => {
      await tx.statuses.create({ id: 'status-todo', workspaceId: 'workspace', name: 'To Do', order: 0 })
      await tx.statuses.create({ id: 'status-done', workspaceId: 'workspace', name: 'Done', order: 1 })
    })

    expect(await readChangeSeq(store)).toBe(before + 1)
  })

  it('leaves the sequence alone when the transaction only read', async () => {
    const before = await readChangeSeq(store)

    await runBoardWrite(store, async ({ tx }) => {
      await tx.statuses.listByWorkspace('workspace')
    })

    expect(await readChangeSeq(store)).toBe(before)
  })

  it('leaves the sequence alone when the transaction rolls back', async () => {
    const before = await readChangeSeq(store)

    await expect(runBoardWrite(store, async ({ tx }) => {
      await tx.statuses.create({ id: 'status-todo', workspaceId: 'workspace', name: 'To Do', order: 0 })
      throw new Error('forced failure after the write')
    })).rejects.toThrow('forced failure')

    expect(await readChangeSeq(store)).toBe(before)
    expect(await store.statuses.listByWorkspace('workspace')).toEqual([])
  })

  it('bumps once for the outer scope when nested writes join it', async () => {
    const before = await readChangeSeq(store)

    await runBoardWrite(store, async (scope) => {
      await runBoardWrite(store, async ({ tx }) => {
        await tx.statuses.create({ id: 'status-todo', workspaceId: 'workspace', name: 'To Do', order: 0 })
      }, scope)
    })

    expect(await readChangeSeq(store)).toBe(before + 1)
  })
})

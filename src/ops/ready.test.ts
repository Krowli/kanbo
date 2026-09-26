import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { BoardStore } from '../board-store'
import type { BoardWorkspaceIdentity } from '../domain/numbering'
import type { TestBoardStore } from '../testing/board-stores'
import { BOARD_STORE_FACTORIES } from '../testing/board-stores'
import { createCard, waitApproval } from './cards'
import { listReady } from './ready'
import { startRun } from './runs'
import type { BoardActor } from './types'

const WORKSPACE: BoardWorkspaceIdentity = { id: 'workspace', identifier: 'WOR', name: 'Workspace' }
const USER: BoardActor = { kind: 'user', id: '__self__' }

describe.each(BOARD_STORE_FACTORIES)('cards ready to be picked up on $name', (factory) => {
  let board: TestBoardStore
  let store: BoardStore

  beforeEach(async () => {
    board = await factory.open([{ id: 'workspace', identifier: 'WOR' }])
    store = board.store
  })

  afterEach(async () => {
    await board.dispose()
  })

  async function createCardIn(title: string, statusName: string) {
    return await createCard(store, { workspace: WORKSPACE, title, statusName }, USER)
  }

  it('offers the To Do cards nobody is working on, and nothing from another column', async () => {
    const ready = await createCardIn('Ready', 'To Do')
    await createCardIn('Still an idea', 'Backlog')
    await createCardIn('Being worked on', 'In Progress')

    expect((await listReady(store, { workspaceId: 'workspace' })).map(card => card.id)).toEqual([ready.id])
  })

  it('leaves out a card that is waiting for a person', async () => {
    const ready = await createCardIn('Ready', 'To Do')
    const waiting = await createCardIn('Waiting', 'To Do')
    await waitApproval(store, waiting.id, {}, USER)

    expect((await listReady(store, { workspaceId: 'workspace' })).map(card => card.id)).toEqual([ready.id])
  })

  it('leaves out a card that already has a run going', async () => {
    const ready = await createCardIn('Ready', 'To Do')
    const launched = await createCardIn('Launched', 'To Do')
    const run = await startRun(store, launched.id, { agentName: 'Claude' }, USER)

    expect((await listReady(store, { workspaceId: 'workspace' })).map(card => card.id)).toEqual([ready.id])

    // A card whose run has ended is ready again.
    await store.runs.update(run.id, { state: 'finished', endedAt: 1 })
    expect((await listReady(store, { workspaceId: 'workspace' })).map(card => card.id))
      .toEqual([ready.id, launched.id])
  })

  it('answers with at most the number of cards the caller asked for', async () => {
    await createCardIn('First', 'To Do')
    await createCardIn('Second', 'To Do')

    expect(await listReady(store, { workspaceId: 'workspace', limit: 1 })).toHaveLength(1)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BoardStore } from '../board-store'
import type { BoardWorkspaceIdentity } from '../domain/numbering'
import type { TestBoardStore } from '../testing/board-stores'
import { BOARD_STORE_FACTORIES } from '../testing/board-stores'
import { bulkUpdateCards } from './card-batch'
import { createCard, deleteCard, moveCard, updateCard } from './cards'
import { listColumnEntries } from './column-entries'
import { ensureDefaultColumns, requireColumn } from './columns'
import type { BoardActor } from './types'

const WORKSPACE: BoardWorkspaceIdentity = { id: 'workspace', identifier: 'WOR', name: 'Workspace' }
const OTHER: BoardWorkspaceIdentity = { id: 'other', identifier: 'OTH', name: 'Other' }
const USER: BoardActor = { kind: 'user', id: '__self__' }
const AGENT: BoardActor = { kind: 'agent', id: 'agent-1' }

/** 2026-01-01T00:00:00Z, in unix seconds. */
const SECOND = 1_767_225_600

describe.each(BOARD_STORE_FACTORIES)('the column-entry feed on $name', (factory) => {
  let board: TestBoardStore
  let store: BoardStore

  beforeEach(async () => {
    board = await factory.open([{ id: WORKSPACE.id, identifier: 'WOR' }, { id: OTHER.id, identifier: 'OTH' }])
    store = board.store
    await ensureDefaultColumns(store, WORKSPACE.id)
    await ensureDefaultColumns(store, OTHER.id)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await board.dispose()
  })

  /** Every write from here on happens at this second. */
  function at(second: number): void {
    vi.spyOn(Date, 'now').mockReturnValue(second * 1000)
  }

  it('counts only real entries against the limit, not cards moved out of every column', async () => {
    const toDo = await requireColumn(store, WORKSPACE.id, 'to_do')
    at(SECOND - 10)
    const cards = [
      await createCard(store, { workspace: WORKSPACE, title: 'One', statusName: 'To Do' }, USER),
      await createCard(store, { workspace: WORKSPACE, title: 'Two', statusName: 'To Do' }, USER),
      await createCard(store, { workspace: WORKSPACE, title: 'Three', statusName: 'To Do' }, USER),
    ]
    for (const [index, card] of cards.entries()) {
      await store.fieldChanges.create({ id: `out-${index}`, issueId: card.id, field: 'statusId', fromValue: toDo.id, toValue: null, createdAt: SECOND })
    }
    at(SECOND + 1)
    const moved = [
      await createCard(store, { workspace: WORKSPACE, title: 'Four', statusName: 'To Do' }, USER),
      await createCard(store, { workspace: WORKSPACE, title: 'Five', statusName: 'To Do' }, USER),
      await createCard(store, { workspace: WORKSPACE, title: 'Six', statusName: 'To Do' }, USER),
    ]

    const entries = await listColumnEntries(store, { workspaceIds: [WORKSPACE.id], since: SECOND, limit: 3 })
    expect(entries.map(entry => entry.issueId).sort()).toEqual(moved.map(card => card.id).sort())
  })

  it('lists every entry into a column of the named boards in time order, a creation as an entry from no column', async () => {
    const [toDo, inProgress] = [await requireColumn(store, WORKSPACE.id, 'to_do'), await requireColumn(store, WORKSPACE.id, 'in_progress')]
    at(SECOND)
    const card = await createCard(store, { workspace: WORKSPACE, title: 'Card', statusName: 'To Do' }, USER)
    at(SECOND + 1)
    await moveCard(store, card.id, 'in_progress', AGENT)
    await updateCard(store, card.id, { priority: 'high' }, AGENT)
    at(SECOND + 2)
    await createCard(store, { workspace: OTHER, title: 'Elsewhere', statusName: 'To Do' }, USER)

    expect(await listColumnEntries(store, { workspaceIds: [WORKSPACE.id], since: SECOND })).toEqual([
      { changeId: expect.any(String), issueId: card.id, workspaceId: WORKSPACE.id, fromStatusId: null, toStatusId: toDo.id, actorKind: 'user', actorId: '__self__', at: SECOND },
      { changeId: expect.any(String), issueId: card.id, workspaceId: WORKSPACE.id, fromStatusId: toDo.id, toStatusId: inProgress.id, actorKind: 'agent', actorId: 'agent-1', at: SECOND + 1 },
    ])
    expect((await listColumnEntries(store, { workspaceIds: [WORKSPACE.id, OTHER.id], since: SECOND })).map(entry => entry.workspaceId))
      .toEqual([WORKSPACE.id, WORKSPACE.id, OTHER.id])
    expect(await listColumnEntries(store, { workspaceIds: [], since: 0 })).toEqual([])
  })

  it('starts at `since` itself, and lists nothing after the last entry', async () => {
    at(SECOND)
    const card = await createCard(store, { workspace: WORKSPACE, title: 'Card', statusName: 'To Do' }, USER)
    at(SECOND + 5)
    await moveCard(store, card.id, 'in_progress', AGENT)

    expect((await listColumnEntries(store, { workspaceIds: [WORKSPACE.id], since: SECOND + 5 })).map(entry => entry.at)).toEqual([SECOND + 5])
    expect(await listColumnEntries(store, { workspaceIds: [WORKSPACE.id], since: SECOND + 6 })).toEqual([])
  })

  it('never ends a page inside a second, so a reader whose cursor stops on a busy second moves on', async () => {
    at(SECOND)
    const cards = [
      await createCard(store, { workspace: WORKSPACE, title: 'A', statusName: 'To Do' }, USER),
      await createCard(store, { workspace: WORKSPACE, title: 'B', statusName: 'To Do' }, USER),
      await createCard(store, { workspace: WORKSPACE, title: 'C', statusName: 'To Do' }, USER),
    ]
    at(SECOND + 1)
    await bulkUpdateCards(store, cards.map(card => card.id), { statusId: (await requireColumn(store, WORKSPACE.id, 'in_progress')).id }, USER)

    const first = await listColumnEntries(store, { workspaceIds: [WORKSPACE.id], since: SECOND, limit: 2 })
    expect(first.map(entry => entry.at)).toEqual([SECOND, SECOND, SECOND])
    const next = await listColumnEntries(store, { workspaceIds: [WORKSPACE.id], since: first.at(-1)!.at + 1, limit: 2 })
    expect(next.map(entry => entry.at)).toEqual([SECOND + 1, SECOND + 1, SECOND + 1])
    expect(new Set([...first, ...next].map(entry => entry.changeId)).size).toBe(6)
    expect(await listColumnEntries(store, { workspaceIds: [WORKSPACE.id], since: SECOND, limit: 3 })).toHaveLength(3)
  })

  it('lists nothing of a card that is gone', async () => {
    at(SECOND)
    const card = await createCard(store, { workspace: WORKSPACE, title: 'Card', statusName: 'To Do' }, USER)
    await deleteCard(store, card.id)

    expect(await listColumnEntries(store, { workspaceIds: [WORKSPACE.id], since: SECOND })).toEqual([])
  })
})

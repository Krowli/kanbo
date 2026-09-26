import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { BoardStore } from '../board-store'
import type { BoardWorkspaceIdentity } from '../domain/numbering'
import type { TestBoardStore } from '../testing/board-stores'
import { BOARD_STORE_FACTORIES } from '../testing/board-stores'
import { bulkUpdateCards, reorderCards } from './card-batch'
import { createCard } from './cards'
import { ensureDefaultColumns } from './columns'
import { createMilestone } from './sprints'
import type { BoardActor } from './types'

const WORKSPACE: BoardWorkspaceIdentity = { id: 'workspace', identifier: 'WOR', name: 'Workspace' }
const OTHER: BoardWorkspaceIdentity = { id: 'other', identifier: 'OTH', name: 'Other' }
const USER: BoardActor = { kind: 'user', id: '__self__' }

describe.each(BOARD_STORE_FACTORIES)('many cards at once on $name', (factory) => {
  let board: TestBoardStore
  let store: BoardStore

  beforeEach(async () => {
    board = await factory.open([{ id: 'workspace', identifier: 'WOR' }, { id: 'other', identifier: 'OTH' }])
    store = board.store
  })

  afterEach(async () => {
    await board.dispose()
  })

  it('changes every named card once, skipping ids the board does not hold, and records each change in that card\'s history', async () => {
    const first = await createCard(store, { workspace: WORKSPACE, title: 'First' }, USER)
    const second = await createCard(store, { workspace: WORKSPACE, title: 'Second', priority: 'high' }, USER)

    const result = await bulkUpdateCards(store, [first.id, second.id, first.id, 'WOR-404'], { priority: 'high', labels: ['bug'] }, USER)

    expect(result).toEqual({ updated: 2 })
    expect((await store.issues.findById(first.id))).toMatchObject({ priority: 'high', labels: '["bug"]' })
    expect((await store.fieldChanges.listByIssue(first.id)).map(change => change.field).toSorted()).toEqual(['labels', 'priority'])
    // A field already at the value is not a change.
    expect((await store.fieldChanges.listByIssue(second.id)).map(change => change.field)).toEqual(['labels'])
  })

  it('refuses a column or a milestone from another card\'s workspace before writing anything', async () => {
    const mine = await createCard(store, { workspace: WORKSPACE, title: 'Mine' }, USER)
    const theirs = await createCard(store, { workspace: OTHER, title: 'Theirs' }, USER)
    const [myFirstColumn] = await ensureDefaultColumns(store, WORKSPACE.id)
    const myMilestone = await createMilestone(store, { workspaceId: WORKSPACE.id, title: 'M1' })

    await expect(bulkUpdateCards(store, [mine.id, theirs.id], { statusId: myFirstColumn.id, priority: 'urgent' }, USER))
      .rejects
      .toMatchObject({ code: 'issue_status_not_found', details: { workspaceId: OTHER.id, statusId: myFirstColumn.id } })
    await expect(bulkUpdateCards(store, [mine.id, theirs.id], { milestoneId: myMilestone.id }, USER))
      .rejects
      .toMatchObject({ code: 'issue_milestone_not_found', details: { workspaceId: OTHER.id, milestoneId: myMilestone.id } })

    expect((await store.issues.findById(mine.id))).toMatchObject({ priority: 'none', milestoneId: null })
    expect(await store.fieldChanges.listByIssue(mine.id)).toEqual([])
  })

  it('places the named cards in the order named, a gap apart, skipping a card of another workspace or one that is gone', async () => {
    const a = await createCard(store, { workspace: WORKSPACE, title: 'A' }, USER)
    const b = await createCard(store, { workspace: WORKSPACE, title: 'B' }, USER)
    const foreign = await createCard(store, { workspace: OTHER, title: 'Foreign' }, USER)
    const foreignOrder = foreign.order

    await reorderCards(store, WORKSPACE.id, [b.id, 'WOR-404', foreign.id, a.id])

    expect((await store.issues.findById(b.id))?.order).toBe(1024)
    expect((await store.issues.findById(a.id))?.order).toBe(4096)
    expect((await store.issues.findById(foreign.id))?.order).toBe(foreignOrder)
  })
})

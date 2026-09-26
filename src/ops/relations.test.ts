import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { BoardStore } from '../board-store'
import type { BoardWorkspaceIdentity } from '../domain/numbering'
import type { TestBoardStore } from '../testing/board-stores'
import { BOARD_STORE_FACTORIES } from '../testing/board-stores'
import { createCard } from './cards'
import { readChangeSeq } from './change-seq'
import { createRelation, deleteRelation, listRelations } from './relations'
import type { BoardActor } from './types'

const WORKSPACE: BoardWorkspaceIdentity = { id: 'workspace', identifier: 'WOR', name: 'Workspace' }
const USER: BoardActor = { kind: 'user', id: '__self__' }

describe.each(BOARD_STORE_FACTORIES)('relations on $name', (factory) => {
  let board: TestBoardStore
  let store: BoardStore

  beforeEach(async () => {
    board = await factory.open([{ id: 'workspace', identifier: 'WOR' }])
    store = board.store
  })

  afterEach(async () => {
    await board.dispose()
  })

  it('refuses an edge from a card to itself, and an edge to a card the board does not hold', async () => {
    const card = await createCard(store, { workspace: WORKSPACE, title: 'Card' }, USER)

    await expect(createRelation(store, { sourceIssueId: card.id, targetIssueId: card.id, type: 'blocks' }))
      .rejects
      .toMatchObject({ code: 'issue_relation_self_reference', details: { issueId: card.id } })
    await expect(createRelation(store, { sourceIssueId: card.id, targetIssueId: 'WOR-404', type: 'blocks' }))
      .rejects
      .toMatchObject({ code: 'issue_not_found', details: { issueId: 'WOR-404' } })
    expect(await store.relations.listByIssue(card.id)).toEqual([])
  })

  it('draws the same edge once: relates_to either way round, a directed edge only the same way round', async () => {
    const a = await createCard(store, { workspace: WORKSPACE, title: 'A' }, USER)
    const b = await createCard(store, { workspace: WORKSPACE, title: 'B' }, USER)

    const related = await createRelation(store, { sourceIssueId: a.id, targetIssueId: b.id, type: 'relates_to' })
    const version = await readChangeSeq(store)
    expect((await createRelation(store, { sourceIssueId: b.id, targetIssueId: a.id, type: 'relates_to' })).id).toBe(related.id)
    expect(await readChangeSeq(store)).toBe(version)

    const blocks = await createRelation(store, { sourceIssueId: a.id, targetIssueId: b.id, type: 'blocks' })
    const blockedBy = await createRelation(store, { sourceIssueId: b.id, targetIssueId: a.id, type: 'blocks' })
    expect(blockedBy.id).not.toBe(blocks.id)
    expect(await store.relations.listByIssue(a.id)).toHaveLength(3)
  })

  it('lists every edge from the card\'s side, with the card on the other end', async () => {
    const a = await createCard(store, { workspace: WORKSPACE, title: 'A' }, USER)
    const b = await createCard(store, { workspace: WORKSPACE, title: 'B', priority: 'high' }, USER)
    const outgoing = await createRelation(store, { sourceIssueId: a.id, targetIssueId: b.id, type: 'blocks' })
    const incoming = await createRelation(store, { sourceIssueId: b.id, targetIssueId: a.id, type: 'duplicates' })

    const listed = await listRelations(store, a.id)
    expect(listed.find(row => row.id === outgoing.id)).toMatchObject({
      direction: 'outgoing',
      counterpart: { id: b.id, workspaceId: 'workspace', number: 2, title: 'B', statusId: b.statusId, priority: 'high' },
    })
    expect(listed.find(row => row.id === incoming.id)).toMatchObject({ direction: 'incoming', counterpart: { id: b.id } })

    await expect(listRelations(store, 'WOR-404')).rejects.toMatchObject({ code: 'issue_not_found' })
  })

  it('deletes an edge, and says so when there is none to delete', async () => {
    const a = await createCard(store, { workspace: WORKSPACE, title: 'A' }, USER)
    const b = await createCard(store, { workspace: WORKSPACE, title: 'B' }, USER)
    const edge = await createRelation(store, { sourceIssueId: a.id, targetIssueId: b.id, type: 'blocks' })

    await deleteRelation(store, edge.id)

    expect(await store.relations.listByIssue(a.id)).toEqual([])
    await expect(deleteRelation(store, edge.id)).rejects.toMatchObject({ code: 'issue_relation_not_found', details: { relationId: edge.id } })
  })
})

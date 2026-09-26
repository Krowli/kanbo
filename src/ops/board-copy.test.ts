import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { BoardStore } from '../board-store'
import type { BoardWorkspaceIdentity } from '../domain/numbering'
import type { TestBoardStore } from '../testing/board-stores'
import { BOARD_STORE_FACTORIES } from '../testing/board-stores'
import { deleteBoardSlice, readBoardSlice, writeBoardSlice } from './board-copy'
import { addComment, createCard, createSubCard } from './cards'
import { createColumn } from './columns'
import { createRelation } from './relations'
import type { BoardActor } from './types'

const WORKSPACE: BoardWorkspaceIdentity = { id: 'workspace', identifier: 'WOR', name: 'Workspace' }
const OTHER: BoardWorkspaceIdentity = { id: 'other', identifier: 'OTH', name: 'Other' }
const USER: BoardActor = { kind: 'user', id: '__self__' }

describe.each(BOARD_STORE_FACTORIES)('copying a workspace\'s board onto $name', (factory) => {
  let source: TestBoardStore
  let target: TestBoardStore
  let from: BoardStore
  let to: BoardStore

  beforeEach(async () => {
    source = await factory.open([{ id: 'workspace', identifier: 'WOR' }, { id: 'other', identifier: 'OTH' }])
    target = await factory.open([{ id: 'workspace', identifier: 'WOR' }])
    from = source.store
    to = target.store
  })

  afterEach(async () => {
    await source.dispose()
    await target.dispose()
  })

  it('copies the workspace\'s rows once, leaves an edge to another workspace behind, and finds a second copy already done', async () => {
    const parent = await createCard(from, { workspace: WORKSPACE, title: 'Parent' }, USER)
    const child = await createSubCard(from, parent.id, { workspace: WORKSPACE, title: 'Child' }, USER)
    const foreign = await createCard(from, { workspace: OTHER, title: 'Foreign' }, USER)
    await createRelation(from, { sourceIssueId: parent.id, targetIssueId: child.id, type: 'blocks' })
    await createRelation(from, { sourceIssueId: parent.id, targetIssueId: foreign.id, type: 'relates_to' })
    await addComment(from, { issueId: child.id, content: 'note' }, USER)

    const slice = await readBoardSlice(from, WORKSPACE.id)
    // A parent before its child, whatever order the store listed them in.
    expect(slice.issues.map(issue => issue.id)).toEqual([parent.id, child.id])
    expect(slice.warnings).toEqual(['1 links to cards in other workspaces were not moved'])

    const first = await writeBoardSlice(to, slice, WORKSPACE.id)
    expect(first.copied).toMatchObject({ statuses: 6, issues: 2, comments: 1, relations: 1 })
    expect((await to.issues.findById(child.id))?.parentIssueId).toBe(parent.id)

    const second = await writeBoardSlice(to, slice, WORKSPACE.id)
    expect(second.copied).toMatchObject({ statuses: 0, issues: 0, comments: 0, relations: 0 })
    expect(second.warnings.at(-1)).toMatch(/rows were already present on the target board/)

    await deleteBoardSlice(from, slice)
    expect(await from.issues.listByWorkspace(WORKSPACE.id)).toEqual([])
    expect(await from.statuses.listByWorkspace(WORKSPACE.id)).toEqual([])
    expect(await from.issues.findById(foreign.id)).not.toBeNull()
  })

  it('refuses the whole copy when the target holds the same column name or card number under another id', async () => {
    await createCard(from, { workspace: WORKSPACE, title: 'From the source' }, USER)
    await createColumn(to, { workspaceId: WORKSPACE.id, name: 'Backlog' }, USER)

    await expect(writeBoardSlice(to, await readBoardSlice(from, WORKSPACE.id), WORKSPACE.id))
      .rejects
      .toMatchObject({ code: 'board_copy_conflict', details: { workspaceId: WORKSPACE.id, conflicts: [{ kind: 'column', value: 'Backlog' }] } })
    expect(await to.issues.listByWorkspace(WORKSPACE.id)).toEqual([])
  })
})

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { BoardStore } from '../board-store'
import type { BoardWorkspaceIdentity } from '../domain/numbering'
import type { TestBoardStore } from '../testing/board-stores'
import { BOARD_STORE_FACTORIES } from '../testing/board-stores'
import { createCard, createSubCard, moveCard } from './cards'
import { createColumn, ensureDefaultColumns } from './columns'
import { migrateCards } from './migrate'
import { createMilestone } from './sprints'
import type { BoardActor } from './types'

const SOURCE: BoardWorkspaceIdentity = { id: 'source', identifier: 'SRC', name: 'Source' }
const TARGET: BoardWorkspaceIdentity = { id: 'target', identifier: 'TGT', name: 'Target' }
const ELSEWHERE: BoardWorkspaceIdentity = { id: 'elsewhere', identifier: 'ELS', name: 'Elsewhere' }
const USER: BoardActor = { kind: 'user', id: '__self__' }

describe.each(BOARD_STORE_FACTORIES)('moving cards between workspaces on $name', (factory) => {
  let board: TestBoardStore
  let store: BoardStore

  beforeEach(async () => {
    board = await factory.open([{ id: 'source', identifier: 'SRC' }, { id: 'target', identifier: 'TGT' }, { id: 'elsewhere', identifier: 'ELS' }])
    store = board.store
  })

  afterEach(async () => {
    await board.dispose()
  })

  async function input(options: { dryRun?: boolean, statusMappings?: Record<string, string>, milestoneMappings?: Record<string, string> } = {}) {
    return {
      sourceId: SOURCE.id,
      targetId: TARGET.id,
      sourceStatuses: await store.statuses.listByWorkspace(SOURCE.id),
      targetStatuses: await ensureDefaultColumns(store, TARGET.id),
      ...options,
    }
  }

  it('maps columns and milestones by name, renumbers a clash, and records the move under the board', async () => {
    await createCard(store, { workspace: TARGET, title: 'Already there' }, USER)
    const targetSprint = await createMilestone(store, { workspaceId: TARGET.id, title: 'Sprint 1' })
    const sourceSprint = await createMilestone(store, { workspaceId: SOURCE.id, title: ' sprint 1 ' })
    const lonelySprint = await createMilestone(store, { workspaceId: SOURCE.id, title: 'Only here' })
    const inProgress = await createCard(store, { workspace: SOURCE, title: 'Working', milestoneId: sourceSprint.id }, USER)
    await moveCard(store, inProgress.id, 'In Progress', USER)
    const custom = await createCard(store, { workspace: SOURCE, title: 'Custom', milestoneId: lonelySprint.id }, USER)
    const qa = await createColumn(store, { workspaceId: SOURCE.id, name: 'QA' }, USER)
    await moveCard(store, custom.id, qa.id, USER)

    const result = await migrateCards(store, await input({ statusMappings: { QA: 'In Review' } }))

    const targetColumns = await store.statuses.listByWorkspace(TARGET.id)
    const columnName = (id: string | null) => targetColumns.find(column => column.id === id)?.name
    const moved = await store.issues.findById(inProgress.id)
    const mapped = await store.issues.findById(custom.id)
    expect(moved).toMatchObject({ workspaceId: TARGET.id, milestoneId: targetSprint.id })
    expect(columnName(moved?.statusId ?? null)).toBe('In Progress')
    expect(mapped).toMatchObject({ workspaceId: TARGET.id, milestoneId: null })
    expect(columnName(mapped?.statusId ?? null)).toBe('In Review')
    // Three cards, three numbers: the one already there keeps number 1.
    expect(new Set([1, moved?.number, mapped?.number]).size).toBe(3)
    expect(result).toMatchObject({ processed: 2, updated: 2, parentIssuesCleared: 0 })
    expect(result.numbersReassigned).toBeGreaterThanOrEqual(1)
    expect(result.milestonesMapped).toContainEqual({ from: 'Only here', to: null })
    expect((await store.fieldChanges.listByIssue(inProgress.id)).find(change => change.field === 'workspaceId'))
      .toMatchObject({ fromValue: SOURCE.id, toValue: TARGET.id, actorKind: 'system', actorId: null })
  })

  it('lets go of a parent in neither workspace, keeps one moving with the card, and writes nothing on a dry run', async () => {
    const foreignParent = await createCard(store, { workspace: ELSEWHERE, title: 'Foreign parent' }, USER)
    const orphan = await createCard(store, { workspace: SOURCE, title: 'Orphan' }, USER)
    await store.issues.update(orphan.id, { parentIssueId: foreignParent.id })
    const parent = await createCard(store, { workspace: SOURCE, title: 'Parent' }, USER)
    const child = await createSubCard(store, parent.id, { workspace: SOURCE, title: 'Child' }, USER)
    await createCard(store, { workspace: TARGET, title: 'Number one' }, USER)

    const preview = await migrateCards(store, await input({ dryRun: true }))
    expect(preview).toMatchObject({ processed: 3, updated: 0, numbersReassigned: 1, parentIssuesCleared: 1 })
    expect((await store.issues.findById(orphan.id))?.workspaceId).toBe(SOURCE.id)

    await migrateCards(store, await input())
    expect((await store.issues.findById(orphan.id))?.parentIssueId).toBeNull()
    expect((await store.issues.findById(child.id))?.parentIssueId).toBe(parent.id)
  })
})

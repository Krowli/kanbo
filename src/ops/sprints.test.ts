import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { BoardStore } from '../board-store'
import { BoardError } from '../domain/errors'
import type { BoardWorkspaceIdentity } from '../domain/numbering'
import type { TestBoardStore } from '../testing/board-stores'
import { BOARD_STORE_FACTORIES } from '../testing/board-stores'
import { createCard, moveCard } from './cards'
import { readChangeSeq } from './change-seq'
import { closeSprint, createMilestone, currentSprint, deleteMilestone, listSprints, updateMilestone } from './sprints'
import type { BoardActor } from './types'

const WORKSPACE: BoardWorkspaceIdentity = { id: 'workspace', identifier: 'WOR', name: 'Workspace' }
const USER: BoardActor = { kind: 'user', id: '__self__' }
const AGENT: BoardActor = { kind: 'agent', id: 'agent-1' }
const DAY = 86_400
const NOW = 1_767_225_600

async function failure(promise: Promise<unknown>): Promise<BoardError> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(BoardError)
  return error as BoardError
}

describe.each(BOARD_STORE_FACTORIES)('sprints on $name', (factory) => {
  let board: TestBoardStore
  let store: BoardStore

  beforeEach(async () => {
    board = await factory.open([{ id: 'workspace', identifier: 'WOR' }, { id: 'other', identifier: 'OTH' }])
    store = board.store
  })

  afterEach(async () => {
    await board.dispose()
  })

  async function sprint(title: string, startDate: number | null, dueDate: number | null, workspaceId = WORKSPACE.id) {
    return await createMilestone(store, { workspaceId, title, startDate, dueDate })
  }

  it('creates a milestone with a start date and changes it, refusing a sprint that starts after it is due', async () => {
    const created = await sprint('Sprint 1', NOW, NOW + 14 * DAY)
    expect(created).toMatchObject({ title: 'Sprint 1', startDate: NOW, dueDate: NOW + 15 * DAY - 1, status: 'open' })

    const moved = await updateMilestone(store, created.id, { startDate: NOW + DAY })
    expect(moved.startDate).toBe(NOW + DAY)

    expect((await failure(sprint('Backwards', NOW, NOW - DAY))).code).toBe('board_sprint_dates_invalid')
    expect((await failure(updateMilestone(store, created.id, { dueDate: NOW }))).code).toBe('board_sprint_dates_invalid')
    expect((await failure(updateMilestone(store, 'missing', { title: 'x' }))).code).toBe('issue_milestone_not_found')
  })

  it('deletes a milestone, and its cards stay on the board belonging to no milestone', async () => {
    const milestone = await sprint('Sprint 1', null, null)
    const card = await createCard(store, { workspace: WORKSPACE, title: 'Card', milestoneId: milestone.id }, USER)

    await deleteMilestone(store, milestone.id)

    expect(await store.milestones.findById(milestone.id)).toBeNull()
    expect((await store.issues.findById(card.id))?.milestoneId).toBeNull()
    expect((await failure(deleteMilestone(store, milestone.id))).details).toEqual({ milestoneId: milestone.id })
  })

  it('keeps dates as calendar days: a start at the first second of its UTC day, a due date at the last, and leaves the dates an edit does not name', async () => {
    // 2026-01-01 21:00Z and 2026-01-14 03:00Z — what a picker east or west of UTC might send.
    const created = await sprint('Sprint 1', NOW + 21 * 3600, NOW + 13 * DAY + 3 * 3600)
    expect(created).toMatchObject({ startDate: NOW, dueDate: NOW + 14 * DAY - 1 })

    const renamed = await updateMilestone(store, created.id, { title: 'Sprint one' })
    expect(renamed).toMatchObject({ title: 'Sprint one', startDate: NOW, dueDate: NOW + 14 * DAY - 1 })

    const moved = await updateMilestone(store, created.id, { dueDate: NOW + 20 * DAY })
    expect(moved).toMatchObject({ startDate: NOW, dueDate: NOW + 21 * DAY - 1 })
    // A sprint of one day starts and ends on it.
    expect(await sprint('One day', NOW + 5, NOW + 10)).toMatchObject({ startDate: NOW, dueDate: NOW + DAY - 1 })
  })

  it('lists the sprints by start date with their open and done cards, and marks the one running now', async () => {
    const plain = await sprint('Plain milestone', null, null)
    const next = await sprint('Sprint 2', NOW + 14 * DAY, NOW + 28 * DAY)
    const running = await sprint('Sprint 1', NOW - DAY, NOW + 13 * DAY)
    const open = await createCard(store, { workspace: WORKSPACE, title: 'Open', milestoneId: running.id }, USER)
    const done = await createCard(store, { workspace: WORKSPACE, title: 'Done', milestoneId: running.id }, USER)
    await moveCard(store, done.id, 'Done', USER)
    const canceled = await createCard(store, { workspace: WORKSPACE, title: 'Dropped', milestoneId: running.id }, USER)
    await moveCard(store, canceled.id, 'Canceled', USER)
    expect(open.milestoneId).toBe(running.id)

    const sprints = await listSprints(store, WORKSPACE.id, NOW)

    expect(sprints.map(item => [item.id, item.current, item.cards])).toEqual([
      [running.id, true, { open: 1, done: 2 }],
      [next.id, false, { open: 0, done: 0 }],
      [plain.id, false, { open: 0, done: 0 }],
    ])
    expect(await listSprints(store, 'other', NOW)).toEqual([])
  })

  it('reads the current sprint: open, started, not yet due — the latest start when several overlap, none otherwise', async () => {
    expect(await currentSprint(store, WORKSPACE.id, NOW)).toBeNull()

    const long = await sprint('Long', NOW - 10 * DAY, NOW + 10 * DAY)
    expect((await currentSprint(store, WORKSPACE.id, NOW))?.id).toBe(long.id)

    const short = await sprint('Short', NOW - DAY, NOW + DAY)
    expect((await currentSprint(store, WORKSPACE.id, NOW))?.id).toBe(short.id)
    // Both edges are inside the sprint, which runs through its due day.
    expect((await currentSprint(store, WORKSPACE.id, NOW - DAY))?.id).toBe(short.id)
    expect((await currentSprint(store, WORKSPACE.id, NOW + 2 * DAY - 1))?.id).toBe(short.id)
    expect((await currentSprint(store, WORKSPACE.id, NOW + 2 * DAY))?.id).toBe(long.id)

    await updateMilestone(store, short.id, { status: 'closed' })
    expect((await currentSprint(store, WORKSPACE.id, NOW))?.id).toBe(long.id)
    expect(await currentSprint(store, WORKSPACE.id, NOW + 11 * DAY)).toBeNull()
    await sprint('Undated', null, null)
    expect(await currentSprint(store, WORKSPACE.id, NOW - 20 * DAY)).toBeNull()
  })

  it('closes a sprint: unfinished cards move to the next one with a history entry each, finished ones stay, in one write', async () => {
    const current = await sprint('Sprint 1', NOW - DAY, NOW + DAY)
    const next = await sprint('Sprint 2', NOW + DAY, NOW + 15 * DAY)
    const todo = await createCard(store, { workspace: WORKSPACE, title: 'Todo', milestoneId: current.id }, USER)
    const started = await createCard(store, { workspace: WORKSPACE, title: 'Started', milestoneId: current.id }, USER)
    await moveCard(store, started.id, 'In Progress', USER)
    const done = await createCard(store, { workspace: WORKSPACE, title: 'Done', milestoneId: current.id }, USER)
    await moveCard(store, done.id, 'Done', USER)
    const elsewhere = await createCard(store, { workspace: WORKSPACE, title: 'No sprint' }, USER)
    const before = await readChangeSeq(store)

    const result = await closeSprint(store, current.id, { carryTo: next.id }, USER)

    expect(result).toEqual({ carried: 2, closed: true })
    expect(await readChangeSeq(store)).toBe(before + 1)
    expect((await store.milestones.findById(current.id))?.status).toBe('closed')
    expect((await store.issues.findById(todo.id))?.milestoneId).toBe(next.id)
    expect((await store.issues.findById(started.id))?.milestoneId).toBe(next.id)
    expect((await store.issues.findById(done.id))?.milestoneId).toBe(current.id)
    expect((await store.issues.findById(elsewhere.id))?.milestoneId).toBeNull()
    expect(await store.fieldChanges.listByIssueField(todo.id, 'milestoneId')).toEqual([
      expect.objectContaining({ fromValue: current.id, toValue: next.id, actorKind: 'user', actorId: '__self__' }),
    ])
    expect(await store.fieldChanges.listByIssueField(done.id, 'milestoneId')).toEqual([])
  })

  it('without a sprint to carry to, takes the unfinished cards out of the milestone', async () => {
    const current = await sprint('Sprint 1', NOW - DAY, NOW + DAY)
    const todo = await createCard(store, { workspace: WORKSPACE, title: 'Todo', milestoneId: current.id }, USER)

    expect(await closeSprint(store, current.id, {}, USER)).toEqual({ carried: 1, closed: true })
    expect((await store.issues.findById(todo.id))?.milestoneId).toBeNull()
  })

  it('does nothing when the sprint is already closed, and leaves the board version alone', async () => {
    const current = await sprint('Sprint 1', NOW - DAY, NOW + DAY)
    const next = await sprint('Sprint 2', NOW + DAY, NOW + 15 * DAY)
    await createCard(store, { workspace: WORKSPACE, title: 'Todo', milestoneId: current.id }, USER)
    await closeSprint(store, current.id, { carryTo: next.id }, USER)
    const version = await readChangeSeq(store)

    expect(await closeSprint(store, current.id, { carryTo: next.id }, USER)).toEqual({ carried: 0, closed: true })
    expect(await readChangeSeq(store)).toBe(version)
  })

  it('lets only a person close a sprint, before touching the board', async () => {
    const current = await sprint('Sprint 1', NOW - DAY, NOW + DAY)
    const version = await readChangeSeq(store)

    const error = await failure(closeSprint(store, current.id, {}, AGENT))

    expect(error.code).toBe('board_sprint_close_requires_user')
    expect((await failure(closeSprint(store, current.id, {}, { kind: 'external', id: 'bot' }))).code)
      .toBe('board_sprint_close_requires_user')
    expect(await readChangeSeq(store)).toBe(version)
    expect((await store.milestones.findById(current.id))?.status).toBe('open')
  })

  it('refuses to carry to a closed milestone, one of another workspace, the sprint itself or none at all, and writes nothing', async () => {
    const current = await sprint('Sprint 1', NOW - DAY, NOW + DAY)
    const todo = await createCard(store, { workspace: WORKSPACE, title: 'Todo', milestoneId: current.id }, USER)
    const closed = await createMilestone(store, { workspaceId: WORKSPACE.id, title: 'Old', status: 'closed' })
    const foreign = await sprint('Theirs', NOW, NOW + DAY, 'other')
    const version = await readChangeSeq(store)

    for (const carryTo of [closed.id, foreign.id, current.id, 'missing']) {
      expect((await failure(closeSprint(store, current.id, { carryTo }, USER))).code).toBe('board_sprint_carry_invalid')
    }
    expect((await failure(closeSprint(store, 'missing', {}, USER))).code).toBe('issue_milestone_not_found')
    expect(await readChangeSeq(store)).toBe(version)
    expect((await store.milestones.findById(current.id))?.status).toBe('open')
    expect((await store.issues.findById(todo.id))?.milestoneId).toBe(current.id)
  })
})

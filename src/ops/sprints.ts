import { randomUUID } from 'node:crypto'

import type { BoardStore } from '../board-store'
import { BoardError } from '../domain/errors'
import { currentUnixSeconds, utcDayEnd, utcDayStart } from '../domain/time'
import type { IssueMilestone, IssueStatus } from '../sqlite/schema'
import { updateCard } from './cards'
import type { BoardWriteScope } from './change-seq'
import { runBoardWrite } from './change-seq'
import type { BoardActor } from './types'

/**
 * A milestone read as a sprint (ruling 5x-3): the row itself, how many of its
 * cards are still open and how many are done, and whether it is the sprint
 * running right now.
 *
 * `done` counts the cards in a `completed` or `canceled` column — the ones
 * closing the sprint leaves where they are; `open` counts every other card,
 * a card in no column at all included — the ones closing it carries on.
 */
export interface BoardSprint extends IssueMilestone {
  cards: { open: number, done: number }
  current: boolean
}

/**
 * What a milestone is created with; `startDate` and `dueDate` are unix seconds,
 * kept as the first and the last second of their UTC days.
 */
export interface CreateMilestoneInput {
  workspaceId: string
  title: string
  description?: string | null
  startDate?: number | null
  dueDate?: number | null
  status?: IssueMilestone['status']
}

/** What of a milestone can change. */
export type UpdateMilestoneInput = Partial<Omit<CreateMilestoneInput, 'workspaceId'>>

/** What closing a sprint did: how many unfinished cards it moved on, and that the sprint is closed. */
export interface CloseSprintResult {
  carried: number
  closed: true
}

const FINISHED_CATEGORIES = new Set<IssueStatus['category']>(['completed', 'canceled'])

/**
 * A milestone's dates as the calendar days they fall on (ruling 5x-6): the
 * start at the first second of its UTC day, the due date at the last. Only the
 * dates the input names are touched.
 */
function toCalendarDays<T extends { startDate?: number | null, dueDate?: number | null }>(input: T): T {
  const days = { ...input }
  if (days.startDate != null) {
    days.startDate = utcDayStart(days.startDate)
  }
  if (days.dueDate != null) {
    days.dueDate = utcDayEnd(days.dueDate)
  }
  return days
}

/** A sprint that starts after it ends is not a sprint. */
function assertDatesInOrder(startDate: number | null | undefined, dueDate: number | null | undefined): void {
  if (startDate != null && dueDate != null && startDate > dueDate) {
    throw new BoardError('board_sprint_dates_invalid', { startDate, dueDate })
  }
}

/** Whether a milestone is the sprint running at `now`: open, started, not yet due. */
function isRunningAt(milestone: IssueMilestone, now: number): boolean {
  return milestone.status === 'open'
    && milestone.startDate !== null
    && milestone.dueDate !== null
    && milestone.startDate <= now
    && now <= milestone.dueDate
}

/**
 * Create a milestone — a sprint when it is given a start and a due date.
 * Milestones carry no history, so there is no actor to record.
 */
export async function createMilestone<TStore extends BoardStore>(
  store: TStore,
  rawInput: CreateMilestoneInput,
  scope?: BoardWriteScope<TStore>,
): Promise<IssueMilestone> {
  const input = toCalendarDays(rawInput)
  assertDatesInOrder(input.startDate, input.dueDate)
  const now = currentUnixSeconds()
  return await runBoardWrite(store, async ({ tx }) => await tx.milestones.create({
    id: randomUUID(),
    workspaceId: input.workspaceId,
    title: input.title,
    description: input.description ?? null,
    startDate: input.startDate ?? null,
    dueDate: input.dueDate ?? null,
    status: input.status ?? 'open',
    createdAt: now,
    updatedAt: now,
  }), scope)
}

/** Change a milestone's title, description, dates or status. */
export async function updateMilestone<TStore extends BoardStore>(
  store: TStore,
  milestoneId: string,
  rawInput: UpdateMilestoneInput,
  scope?: BoardWriteScope<TStore>,
): Promise<IssueMilestone> {
  const input = toCalendarDays(rawInput)
  return await runBoardWrite(store, async ({ tx }) => {
    const milestone = await requireMilestone(tx, milestoneId)
    assertDatesInOrder(
      'startDate' in input ? input.startDate : milestone.startDate,
      'dueDate' in input ? input.dueDate : milestone.dueDate,
    )
    const updates: Partial<IssueMilestone> = { updatedAt: currentUnixSeconds() }
    if (input.title !== undefined) {
      updates.title = input.title
    }
    if ('description' in input) {
      updates.description = input.description ?? null
    }
    if ('startDate' in input) {
      updates.startDate = input.startDate ?? null
    }
    if ('dueDate' in input) {
      updates.dueDate = input.dueDate ?? null
    }
    if (input.status !== undefined) {
      updates.status = input.status
    }
    await tx.milestones.update(milestoneId, updates)
    return await requireMilestone(tx, milestoneId)
  }, scope)
}

/** Milestones, newest first — one workspace's, or with `null` every workspace's on the board. */
export async function listMilestones(store: BoardStore, workspaceId: string | null): Promise<IssueMilestone[]> {
  return await store.milestones.listNewestFirst(workspaceId)
}

/**
 * Delete a milestone. Its cards stay where they are and simply belong to no
 * milestone any more — the reference is cleared in the same write, so no card
 * is ever left naming a milestone that is gone.
 */
export async function deleteMilestone<TStore extends BoardStore>(
  store: TStore,
  milestoneId: string,
  scope?: BoardWriteScope<TStore>,
): Promise<void> {
  await runBoardWrite(store, async ({ tx }) => {
    await requireMilestone(tx, milestoneId)
    await tx.issues.clearMilestoneReferences(milestoneId, currentUnixSeconds())
    await tx.milestones.delete(milestoneId)
  }, scope)
}

/**
 * Every milestone of a workspace as a sprint, the one running at `now` marked
 * `current`. Ordered by start date, the milestones without one last, then by
 * due date and creation.
 */
export async function listSprints(
  store: BoardStore,
  workspaceId: string,
  now: number = currentUnixSeconds(),
): Promise<BoardSprint[]> {
  const [milestones, cards, columns] = await Promise.all([
    store.milestones.listByWorkspace(workspaceId),
    store.issues.listByWorkspace(workspaceId),
    store.statuses.listByWorkspace(workspaceId),
  ])
  const finishedColumns = new Set(columns
    .filter(column => FINISHED_CATEGORIES.has(column.category))
    .map(column => column.id))
  const current = pickCurrent(milestones, now)

  return milestones
    .toSorted((a, b) =>
      (a.startDate ?? Number.MAX_SAFE_INTEGER) - (b.startDate ?? Number.MAX_SAFE_INTEGER)
      || (a.dueDate ?? Number.MAX_SAFE_INTEGER) - (b.dueDate ?? Number.MAX_SAFE_INTEGER)
      || a.createdAt - b.createdAt)
    .map((milestone) => {
      const own = cards.filter(card => card.milestoneId === milestone.id)
      const done = own.filter(card => card.statusId !== null && finishedColumns.has(card.statusId)).length
      return { ...milestone, cards: { open: own.length - done, done }, current: milestone.id === current?.id }
    })
}

/**
 * The sprint running at `now`: an open milestone with `start_date <= now <=
 * due_date`. When several overlap, the one that started last; when none does,
 * `null`.
 */
export async function currentSprint(
  store: BoardStore,
  workspaceId: string,
  now: number = currentUnixSeconds(),
): Promise<BoardSprint | null> {
  return (await listSprints(store, workspaceId, now)).find(sprint => sprint.current) ?? null
}

function pickCurrent(milestones: IssueMilestone[], now: number): IssueMilestone | null {
  return milestones
    .filter(milestone => isRunningAt(milestone, now))
    .reduce<IssueMilestone | null>((latest, milestone) =>
      latest === null || (milestone.startDate ?? 0) > (latest.startDate ?? 0) ? milestone : latest, null)
}

/**
 * Close a sprint, carrying its unfinished cards on (rulings 5x-3, 5x-4).
 *
 * Only a person closes a sprint: deciding what did not get done is a review of
 * the work, and an agent is one of the parties being reviewed. Every card of the
 * sprint whose column is not `completed` or `canceled` moves to `carryTo` — an
 * open milestone of the same workspace — through `updateCard`, so each one gets
 * the same `milestoneId` history entry any other edit would. Without `carryTo`
 * those cards leave the milestone instead. The finished cards stay where they
 * are, and the sprint is closed, all in one write.
 *
 * Closing a sprint that is already closed does nothing and says so with
 * `carried: 0` — the board version does not move.
 */
export async function closeSprint<TStore extends BoardStore>(
  store: TStore,
  milestoneId: string,
  input: { carryTo?: string | null },
  actor: BoardActor,
  scope?: BoardWriteScope<TStore>,
): Promise<CloseSprintResult> {
  if (actor.kind !== 'user') {
    throw new BoardError('board_sprint_close_requires_user', { milestoneId, actorKind: actor.kind })
  }

  return await runBoardWrite(store, async ({ tx }) => {
    const sprint = await requireMilestone(tx, milestoneId)
    if (sprint.status === 'closed') {
      return { carried: 0, closed: true }
    }
    const carryTo = input.carryTo ?? null
    if (carryTo !== null) {
      const target = await tx.milestones.findInWorkspace(sprint.workspaceId, carryTo)
      if (!target || target.status !== 'open' || target.id === sprint.id) {
        throw new BoardError('board_sprint_carry_invalid', { milestoneId, carryTo })
      }
    }

    const finishedColumns = new Set((await tx.statuses.listByWorkspace(sprint.workspaceId))
      .filter(column => FINISHED_CATEGORIES.has(column.category))
      .map(column => column.id))
    const unfinished = (await tx.issues.listByWorkspace(sprint.workspaceId))
      .filter(card => card.milestoneId === sprint.id && !(card.statusId !== null && finishedColumns.has(card.statusId)))
    for (const card of unfinished) {
      await updateCard(tx, card.id, { milestoneId: carryTo }, actor, { tx })
    }
    await tx.milestones.update(sprint.id, { status: 'closed', updatedAt: currentUnixSeconds() })
    return { carried: unfinished.length, closed: true }
  }, scope)
}

async function requireMilestone(store: BoardStore, milestoneId: string): Promise<IssueMilestone> {
  const milestone = await store.milestones.findById(milestoneId)
  if (!milestone) {
    throw new BoardError('issue_milestone_not_found', { milestoneId })
  }
  return milestone
}

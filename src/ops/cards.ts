import type { BoardStore } from '../board-store'
import type { UnmetEntryRule } from '../domain/entry-rules'
import { BoardError } from '../domain/errors'
import { diffFieldChanges } from '../domain/field-changes'
import type { BoardWorkspaceIdentity } from '../domain/numbering'
import { nextIssueIdentity, nextIssueNumber, nextIssueOrder } from '../domain/numbering'
import { normalizeStatusName } from '../domain/status-name'
import { currentUnixSeconds } from '../domain/time'
import type { Issue, IssueComment, issues, IssueStatus } from '../sqlite/schema'
import { APPROVED_COMMENT } from './approval'
import type { BoardWriteScope } from './change-seq'
import { runBoardWrite } from './change-seq'
import { ensureDefaultColumns, listColumns, requireColumn } from './columns'
import { enforceColumnEntry } from './entry-rules'
import { readBoardProjectionForIssue, stopRunningRuns } from './runs'
import type { BoardActor, BoardCommentInput } from './types'
import { BOARD_ACTOR, insertComment, requireCard, toStoredActorKind, writeStatusLine } from './types'

/** Which column a caller means, when it may name either. */
interface ColumnReference {
  statusId?: string | null
  statusName?: string | null
}

/** A new card. The workspace comes in resolved: the board never reads anybody else's tables to find it. */
export interface CreateCardInput extends ColumnReference {
  workspace: BoardWorkspaceIdentity
  /** Optional: a card written as a description alone is titled with its own key. */
  title?: string | null
  description?: string | null
  priority?: Issue['priority']
  labels?: string[]
  milestoneId?: string | null
  parentIssueId?: string | null
  dueDate?: number | null
  assigneeKind?: string | null
  assigneeId?: string | null
  executionMode?: Issue['executionMode']
}

/** Everything a card's fields can be changed to. */
export interface UpdateCardInput extends ColumnReference {
  workspaceId?: string
  title?: string
  description?: string | null
  priority?: Issue['priority']
  labels?: string[]
  milestoneId?: string | null
  parentIssueId?: string | null
  assigneeKind?: string | null
  assigneeId?: string | null
  dueDate?: number | null
  order?: number
  executionMode?: Issue['executionMode']
}

/**
 * What a return writes as the card's status line, ahead of the person's own
 * reason. Read by the person and by the agent the card goes back to, so it
 * names neither as "you".
 */
export const RETURNED_STATUS_LINE_PREFIX = 'returned by a person: '

/**
 * A card as a write that may have put it in a column hands it back. `unmetRules`
 * is there only when a person put the card in a column whose entry rules it does
 * not meet (ruling 6-3) — the write went through, and this is what to warn them
 * about. An agent never sees it: it is refused instead.
 */
export type BoardCardWrite = Issue & { unmetRules?: UnmetEntryRule[] }

/** A card and the rules it entered its column without — the field only when there are some. */
function withUnmetRules(card: Issue, unmet: UnmetEntryRule[]): BoardCardWrite {
  return unmet.length > 0 ? { ...card, unmetRules: unmet } : card
}

/** How many times a card creation retries a number another writer took first. */
const NUMBERING_ATTEMPTS = 3

/**
 * Put a new card on the board.
 *
 * The key and the number are taken inside the write, because they are read from
 * the board itself: two writers picking `WOR-004` at the same moment is the one
 * collision the unique index cannot be argued out of, and the loser simply takes
 * the next free number instead. A failure that is not about numbering — a
 * milestone that no longer exists, a parent in another workspace — is not
 * retried; it would fail the same way three times.
 *
 * A card needs no title: one created without it (or with a blank one) is titled
 * with its key, so a person or an agent can write only what the task is.
 */
export async function createCard<TStore extends BoardStore>(
  store: TStore,
  input: CreateCardInput,
  actor: BoardActor,
  scope?: BoardWriteScope<TStore>,
): Promise<BoardCardWrite> {
  const workspaceId = input.workspace.id

  return await runBoardWrite(store, async ({ tx }) => {
    const statusId = await resolveColumnReference(tx, workspaceId, input, { useDefaultWhenMissing: true })
    // The column's entry rules hold for a new card as for a moved one: a card
    // being created has no pull request and no decision yet, only the
    // checklist it is written with.
    const column = statusId === null ? null : await tx.statuses.findById(statusId)
    const unmet = column
      ? await enforceColumnEntry(tx, { id: null, description: input.description ?? null }, column, actor)
      : []
    const milestoneId = await requireMilestoneInWorkspace(tx, workspaceId, input.milestoneId ?? null)
    // The parent is checked before the key is generated: a key the board has not
    // handed out yet cannot be its own parent, so only the workspace matters.
    const parentIssueId = await requireParentInWorkspace(tx, workspaceId, input.parentIssueId ?? null)
    const order = await nextIssueOrder(workspaceId, tx)
    const now = currentUnixSeconds()

    for (let attempt = 1; ; attempt++) {
      const identity = await nextIssueIdentity(input.workspace, tx)
      try {
        return withUnmetRules(await tx.issues.create({
          id: identity.id,
          workspaceId,
          title: input.title?.trim() || identity.id,
          description: input.description ?? null,
          priority: input.priority ?? 'none',
          labels: JSON.stringify(input.labels ?? []),
          milestoneId,
          parentIssueId,
          statusId,
          number: identity.number,
          assigneeKind: input.assigneeKind ?? null,
          assigneeId: input.assigneeId ?? null,
          dueDate: input.dueDate ?? null,
          createdByKind: toStoredActorKind(actor),
          createdById: actor.id ?? '__self__',
          sourceChatSessionId: actor.chatSessionId ?? null,
          delegateAgentId: null,
          delegateProviderTargetId: null,
          contextRefs: '[]',
          executionMode: input.executionMode ?? 'worktree',
          order,
          createdAt: now,
          updatedAt: now,
        }), unmet)
      }
      catch (error) {
        // The board, not the driver, says whether this was a numbering
        // collision: the key or the number is now taken by a row that is not
        // this one. Anything else is a real failure and belongs to the caller.
        const numberTaken = await tx.issues.findByNumber(workspaceId, identity.number)
        const keyTaken = await tx.issues.findById(identity.id)
        if (attempt >= NUMBERING_ATTEMPTS || (!numberTaken && !keyTaken)) {
          throw error
        }
      }
    }
  }, scope)
}

/** Put a new card under an existing one, in the parent's workspace. */
export async function createSubCard<TStore extends BoardStore>(
  store: TStore,
  parentIssueId: string,
  input: Omit<CreateCardInput, 'parentIssueId'>,
  actor: BoardActor,
  scope?: BoardWriteScope<TStore>,
): Promise<BoardCardWrite> {
  return await runBoardWrite(store, async ({ tx }) => {
    const parent = await requireCard(tx, parentIssueId)
    return await createCard(tx, { ...input, parentIssueId: parent.id }, actor, { tx })
  }, scope)
}

/**
 * Change a card's fields, recording every tracked one in its history.
 *
 * Moving a card to another workspace is part of this: the card takes that
 * board's columns, drops a milestone or a parent that does not live there, goes
 * to the end of the board, and takes a new number if its own is already in use.
 * The execution mode is the one field that stops being editable — once a card
 * has been launched, where it runs is a fact about work that already happened.
 *
 * Naming a column the card is not in yet is putting it there, and the column's
 * entry rules are checked against the card as this write leaves it — a
 * description ticked off in the same update counts (ruling 6-3). So is the
 * first column a card lands in because it changed workspace (ruling 6-7): the
 * caller asked for the move, so it is not the board's own doing.
 */
export async function updateCard<TStore extends BoardStore>(
  store: TStore,
  issueId: string,
  input: UpdateCardInput,
  actor: BoardActor,
  scope?: BoardWriteScope<TStore>,
): Promise<BoardCardWrite> {
  return await runBoardWrite(store, async ({ tx }) => {
    const card = await requireCard(tx, issueId)
    const workspaceId = input.workspaceId ?? card.workspaceId
    const workspaceChanged = workspaceId !== card.workspaceId
    const updates: Partial<typeof issues.$inferInsert> = { updatedAt: currentUnixSeconds() }

    if ('workspaceId' in input) {
      updates.workspaceId = workspaceId
    }
    if (workspaceChanged) {
      if (!('statusId' in input) && !('statusName' in input)) {
        updates.statusId = await resolveColumnReference(tx, workspaceId, {}, { useDefaultWhenMissing: true })
      }
      if (!('milestoneId' in input)) {
        updates.milestoneId = card.milestoneId && await tx.milestones.findInWorkspace(workspaceId, card.milestoneId)
          ? card.milestoneId
          : null
      }
      if (!('parentIssueId' in input)) {
        updates.parentIssueId = card.parentIssueId && await tx.issues.findInWorkspace(workspaceId, card.parentIssueId)
          ? card.parentIssueId
          : null
      }
      if (input.order === undefined) {
        updates.order = await nextIssueOrder(workspaceId, tx)
      }
      if (await numberTakenByAnother(tx, workspaceId, card)) {
        updates.number = await nextIssueNumber(workspaceId, tx)
      }
    }
    if (input.title !== undefined) {
      updates.title = input.title
    }
    if ('description' in input) {
      updates.description = input.description ?? null
    }
    if (input.priority !== undefined) {
      updates.priority = input.priority
    }
    if (input.labels !== undefined) {
      updates.labels = JSON.stringify(input.labels)
    }
    if ('milestoneId' in input) {
      updates.milestoneId = await requireMilestoneInWorkspace(tx, workspaceId, input.milestoneId ?? null)
    }
    if ('parentIssueId' in input) {
      updates.parentIssueId = await requireParentInWorkspace(tx, workspaceId, input.parentIssueId ?? null, issueId)
    }
    if ('statusId' in input || 'statusName' in input) {
      updates.statusId = await resolveColumnReference(tx, workspaceId, input, { useDefaultWhenMissing: false })
    }
    // Named, or the first column of the board the card moved to (ruling 6-7):
    // either way the card is entering it.
    let unmet: UnmetEntryRule[] = []
    const column = updates.statusId && updates.statusId !== card.statusId
      ? await tx.statuses.findById(updates.statusId)
      : null
    if (column) {
      const description = 'description' in updates ? updates.description ?? null : card.description
      unmet = await enforceColumnEntry(tx, { id: card.id, description }, column, actor)
    }
    if ('assigneeKind' in input) {
      updates.assigneeKind = input.assigneeKind ?? null
    }
    if ('assigneeId' in input) {
      updates.assigneeId = input.assigneeId ?? null
    }
    if ('dueDate' in input) {
      updates.dueDate = input.dueDate ?? null
    }
    if (input.order !== undefined) {
      updates.order = input.order
    }
    if (input.executionMode !== undefined && input.executionMode !== card.executionMode) {
      if ((await readBoardProjectionForIssue(tx, issueId)).attemptCount > 0) {
        throw new BoardError('board_execution_mode_locked', { issueId, executionMode: card.executionMode })
      }
      updates.executionMode = input.executionMode
    }

    await recordFieldChanges(tx, card, updates, actor)
    await tx.issues.update(issueId, updates)
    return withUnmetRules(await requireCard(tx, issueId), unmet)
  }, scope)
}

/**
 * Move a card to the column named by id, by slug or by name — through
 * `updateCard`, so the column's entry rules hold here too.
 */
export async function moveCard<TStore extends BoardStore>(
  store: TStore,
  issueId: string,
  nameOrId: string,
  actor: BoardActor,
  scope?: BoardWriteScope<TStore>,
): Promise<BoardCardWrite> {
  return await runBoardWrite(store, async ({ tx }) => {
    const card = await requireCard(tx, issueId)
    await ensureDefaultColumns(tx, card.workspaceId, { tx })
    const column = await requireColumn(tx, card.workspaceId, nameOrId)
    return await updateCard(tx, issueId, { statusId: column.id }, actor, { tx })
  }, scope)
}

/** Say what the card is doing right now. */
export async function setStatusLine<TStore extends BoardStore>(
  store: TStore,
  issueId: string,
  statusLine: string | null,
  actor: BoardActor,
  scope?: BoardWriteScope<TStore>,
): Promise<Issue> {
  return await runBoardWrite(store, async ({ tx }) => {
    const card = await requireCard(tx, issueId)
    await writeStatusLine(tx, card, statusLine, actor)
    return await requireCard(tx, issueId)
  }, scope)
}

/**
 * Hand the card to a person and stop working on it. Only a person takes it back
 * — through `approve` or `returnCard` — which is the whole point of the flag.
 */
export async function waitApproval<TStore extends BoardStore>(
  store: TStore,
  issueId: string,
  input: { statusLine?: string | null },
  actor: BoardActor,
  scope?: BoardWriteScope<TStore>,
): Promise<Issue> {
  return await runBoardWrite(store, async ({ tx }) => {
    const card = await requireCard(tx, issueId)
    await tx.issues.update(issueId, { waitingFor: 'human', updatedAt: currentUnixSeconds() })
    if (input.statusLine !== undefined) {
      await writeStatusLine(tx, { ...card, waitingFor: 'human' }, input.statusLine, actor)
    }
    return await requireCard(tx, issueId)
  }, scope)
}

/**
 * Accept the work: the card stops waiting, and the decision is written down.
 *
 * Nothing but a person may do this. On a local board file that is an agreement
 * rather than a lock — the same file is writable by anything that can open it —
 * but the agreement is worth having: an agent that could approve its own work
 * would make the whole waiting state meaningless.
 */
export async function approve<TStore extends BoardStore>(
  store: TStore,
  issueId: string,
  input: { comment?: string | null },
  actor: BoardActor,
  scope?: BoardWriteScope<TStore>,
): Promise<Issue> {
  if (actor.kind !== 'user') {
    throw new BoardError('board_approval_requires_user', { issueId, actorKind: actor.kind })
  }

  return await runBoardWrite(store, async ({ tx }) => {
    await requireCard(tx, issueId)
    await tx.issues.update(issueId, { waitingFor: null, updatedAt: currentUnixSeconds() })
    const comment = input.comment?.trim()
    await insertComment(tx, {
      issueId,
      authorKind: 'system.approved',
      content: comment ? `${APPROVED_COMMENT}\n${comment}` : APPROVED_COMMENT,
      authorId: actor.id,
      sourceChatSessionId: actor.chatSessionId,
    })
    return await requireCard(tx, issueId)
  }, scope)
}

/**
 * Send the card back a column with a reason.
 *
 * The reason is the point: it goes on the card as the person's own comment and
 * as the status line, so the next agent to pick the card up reads why it came
 * back before anything else. Whatever was running on the card is stopped in the
 * same write — a card sitting a column earlier while an agent still works on it
 * is the state the board must never be left in.
 *
 * This is a person's, exactly as `approve` is. They are the two answers to a
 * card that is waiting for a human, and an agent that could give either of them
 * could undo the one state the board promises a person owns — the line it
 * leaves even says "returned by a person".
 */
export async function returnCard<TStore extends BoardStore>(
  store: TStore,
  issueId: string,
  input: { comment: string, toStatusName?: string | null },
  actor: BoardActor,
  scope?: BoardWriteScope<TStore>,
): Promise<{ card: Issue, stoppedRunIds: string[] }> {
  return await runBoardWrite(store, async ({ tx }) => {
    await ensureDefaultColumns(tx, (await requireCard(tx, issueId)).workspaceId, { tx })
    const target = await assertReturnable(tx, issueId, input, actor)
    const card = await requireCard(tx, issueId)

    const updates = { statusId: target.id, waitingFor: null, updatedAt: currentUnixSeconds() } as const
    await recordFieldChanges(tx, card, updates, actor)
    await tx.issues.update(issueId, updates)
    await insertComment(tx, {
      issueId,
      authorKind: 'system.returned',
      content: input.comment,
      authorId: actor.id,
      sourceChatSessionId: actor.chatSessionId,
    })

    // The board stops the runs on its own behalf: the person is returning the
    // card, not pressing stop, and the line below is the one they should read.
    const stoppedRunIds = await stopRunningRuns(tx, issueId, BOARD_ACTOR, { tx })
    await writeStatusLine(tx, await requireCard(tx, issueId), `${RETURNED_STATUS_LINE_PREFIX}${input.comment}`, actor)

    return { card: await requireCard(tx, issueId), stoppedRunIds }
  }, scope)
}

/**
 * Every reason `returnCard` would refuse, asked on reads alone, and the column
 * the card would go back to when none applies.
 *
 * `returnCard` asks exactly this inside its write. A caller that has to undo
 * something of its own before the return — stop listening for the approval the
 * card is waiting on, say — asks it first, so a return the board refuses leaves
 * that untouched. The refusals are the same `BoardError` codes: an actor who is
 * not a person (`board_return_requires_user`), a card that is not there
 * (`issue_not_found`), a named column the workspace does not hold
 * (`issue_status_not_found`), and a card already in the first column with no
 * column named (`board_return_no_previous_column`).
 */
export async function assertReturnable(
  store: BoardStore,
  issueId: string,
  input: { toStatusName?: string | null },
  actor: BoardActor,
): Promise<IssueStatus> {
  if (actor.kind !== 'user') {
    throw new BoardError('board_return_requires_user', { issueId, actorKind: actor.kind })
  }

  const card = await requireCard(store, issueId)
  return input.toStatusName
    ? await requireColumn(store, card.workspaceId, input.toStatusName)
    : previousColumn(await listColumns(store, card.workspaceId), card)
}

/** A comment a person or an agent writes; the author defaults to the actor. */
export interface AddCommentInput extends Omit<BoardCommentInput, 'authorKind' | 'dedupeKey'> {
  authorKind?: BoardCommentInput['authorKind']
}

/** A fact the board records once, however many times it is told. */
export interface CreateCommentOnceInput {
  issueId: string
  authorKind: BoardCommentInput['authorKind']
  content: string
  dedupeKey: string
  actor: BoardActor
}

/** Write a comment on the card, as the actor unless the caller names another author. */
export async function addComment<TStore extends BoardStore>(
  store: TStore,
  input: AddCommentInput,
  actor: BoardActor,
  scope?: BoardWriteScope<TStore>,
): Promise<IssueComment> {
  return await runBoardWrite(store, async ({ tx }) => {
    await requireCard(tx, input.issueId)
    const authorKind = input.authorKind ?? toStoredActorKind(actor)
    return await insertComment(tx, {
      ...input,
      authorKind,
      authorId: input.authorId !== undefined ? input.authorId : actor.id,
      sourceChatSessionId: input.sourceChatSessionId !== undefined ? input.sourceChatSessionId : actor.chatSessionId,
    })
  }, scope)
}

/**
 * Write a fact on the card, once. A fact — a pull request opened, a check that
 * went green — is reported by whatever noticed it, as often as it notices;
 * `dedupeKey` is what keeps the card from saying it twice.
 */
export async function createCommentOnce<TStore extends BoardStore>(
  store: TStore,
  input: CreateCommentOnceInput,
  scope?: BoardWriteScope<TStore>,
): Promise<IssueComment> {
  return await runBoardWrite(store, async ({ tx }) => {
    await requireCard(tx, input.issueId)
    return await insertComment(tx, {
      issueId: input.issueId,
      authorKind: input.authorKind,
      content: input.content,
      dedupeKey: input.dedupeKey,
      authorId: input.actor.id,
      sourceChatSessionId: input.actor.chatSessionId,
    })
  }, scope)
}

/** The card's comments, oldest first. */
export async function listComments(store: BoardStore, issueId: string): Promise<IssueComment[]> {
  await requireCard(store, issueId)
  return await store.comments.listByIssue(issueId)
}

/**
 * Delete a comment. A comment the board wrote — a decision (`system.*`) or a
 * fact it keeps once (`dedupeKey`, CI among them) — is a person's to delete:
 * the board reads the newest of them, so an agent deleting one could revive an
 * older approval or an older green CI run.
 */
export async function deleteComment<TStore extends BoardStore>(
  store: TStore,
  commentId: string,
  actor: BoardActor,
  scope?: BoardWriteScope<TStore>,
): Promise<void> {
  await runBoardWrite(store, async ({ tx }) => {
    const comment = await tx.comments.findById(commentId)
    if (!comment) {
      throw new BoardError('issue_comment_not_found', { commentId })
    }
    if (actor.kind !== 'user' && (comment.authorKind.startsWith('system.') || comment.dedupeKey !== null)) {
      throw new BoardError('issue_comment_delete_requires_user', { commentId, actorKind: toStoredActorKind(actor) })
    }
    await tx.comments.delete(commentId)
  }, scope)
}

/**
 * Take a card off the board, and hand back the ids of the runs that went with
 * it — a host that keeps rows of its own naming those runs lets go of them.
 *
 * Its children stay on the board without a parent, and every edge touching it
 * goes in both directions: an edge is not a child, and a counterpart left
 * holding half of one would render a relation to nothing.
 */
export async function deleteCard<TStore extends BoardStore>(
  store: TStore,
  issueId: string,
  scope?: BoardWriteScope<TStore>,
): Promise<{ runIds: string[] }> {
  return await runBoardWrite(store, async ({ tx }) => {
    await requireCard(tx, issueId)
    const runIds = (await tx.runs.listByIssue(issueId)).map(run => run.id)
    await tx.issues.clearParentReferences(issueId, currentUnixSeconds())
    await tx.relations.deleteByIssue(issueId)
    await tx.issues.delete(issueId)
    return { runIds }
  }, scope)
}

/**
 * Cards whose key, number, title or description carry the text, ignoring case,
 * newest first and at most `limit` of them.
 *
 * Newest first is the order a host merging several boards' answers relies on:
 * each board's answer is already sorted on `createdAt`, so a stable merge on it
 * and a second cut to `limit` give the answer one board holding every card would.
 */
export async function searchCards(store: BoardStore, query: string, limit: number): Promise<Issue[]> {
  const needle = query.toLowerCase()
  return (await store.issues.listNewestFirst())
    .filter(card => [card.id, String(card.number), card.title, card.description ?? ''].join(' ').toLowerCase().includes(needle))
    .slice(0, limit)
}

/** The column before the card's own, or the error that says there is none. */
function previousColumn(columns: IssueStatus[], card: Issue) {
  const index = columns.findIndex(column => column.id === card.statusId)
  const previous = index > 0 ? columns[index - 1] : undefined
  if (!previous) {
    throw new BoardError('board_return_no_previous_column', { issueId: card.id, statusId: card.statusId })
  }
  return previous
}

/** Append the history rows a patch earns, one per tracked field it actually changes. */
export async function recordFieldChanges(
  store: BoardStore,
  card: Issue,
  updates: Partial<typeof issues.$inferInsert>,
  actor: BoardActor,
): Promise<void> {
  const rows = diffFieldChanges(card, updates, {
    kind: toStoredActorKind(actor),
    id: actor.id,
    sourceChatSessionId: actor.chatSessionId ?? null,
  }, currentUnixSeconds())
  for (const row of rows) {
    await store.fieldChanges.create(row)
  }
}

/**
 * The column a caller named, seeding the standard columns first so a board that
 * has never been opened still has somewhere to put the card. Naming both an id
 * and a name is a caller mistake, not a preference to resolve.
 */
async function resolveColumnReference(
  store: BoardStore,
  workspaceId: string,
  reference: ColumnReference,
  options: { useDefaultWhenMissing: boolean },
): Promise<string | null> {
  if (reference.statusId != null && reference.statusName != null) {
    throw new BoardError('issue_status_reference_conflict', {
      statusId: reference.statusId,
      statusName: reference.statusName,
    })
  }
  if (reference.statusId == null && reference.statusName == null && !options.useDefaultWhenMissing) {
    return null
  }

  const columns = await ensureDefaultColumns(store, workspaceId, { tx: store })

  // A caller that named an id is answered about that id, and one that named a
  // name about that name: the failure has to hand back what was actually sent,
  // or the client is told it asked something it did not ask.
  if (reference.statusId != null) {
    const column = columns.find(candidate => candidate.id === reference.statusId)
    if (!column) {
      throw new BoardError('issue_status_not_found', { workspaceId, statusId: reference.statusId })
    }
    return column.id
  }

  if (reference.statusName != null) {
    const slug = normalizeStatusName(reference.statusName)
    if (!slug) {
      throw new BoardError('issue_status_name_empty', { workspaceId })
    }
    const column = columns.find(candidate => normalizeStatusName(candidate.name) === slug)
    if (!column) {
      throw new BoardError('issue_status_not_found', {
        workspaceId,
        statusName: reference.statusName,
        normalizedStatusName: slug,
      })
    }
    return column.id
  }

  return columns[0]?.id ?? null
}

/** The milestone, when it belongs to the workspace, or the error that says it does not. */
export async function requireMilestoneInWorkspace(
  store: BoardStore,
  workspaceId: string,
  milestoneId: string | null,
): Promise<string | null> {
  if (milestoneId === null) {
    return null
  }
  const milestone = await store.milestones.findInWorkspace(workspaceId, milestoneId)
  if (!milestone) {
    throw new BoardError('issue_milestone_not_found', { workspaceId, milestoneId })
  }
  return milestone.id
}

async function requireParentInWorkspace(
  store: BoardStore,
  workspaceId: string,
  parentIssueId: string | null,
  issueId?: string,
): Promise<string | null> {
  if (parentIssueId === null) {
    return null
  }
  if (parentIssueId === issueId) {
    throw new BoardError('issue_parent_self_reference', { issueId, parentIssueId })
  }
  const parent = await store.issues.findInWorkspace(workspaceId, parentIssueId)
  if (!parent) {
    throw new BoardError('issue_parent_not_found', { workspaceId, parentIssueId })
  }
  if (issueId !== undefined && await isUnder(store, parent, issueId)) {
    throw new BoardError('issue_parent_cycle', { issueId, parentIssueId })
  }
  return parentIssueId
}

/**
 * Is the card somewhere under `ancestorId` — its parent, its parent's parent,
 * and so on up? A card put under one of its own sub-cards would make a loop no
 * reader of the board can walk to the top of. The cards already seen end the
 * walk, so a loop the data holds from before cannot hang it.
 */
async function isUnder(store: BoardStore, card: Issue, ancestorId: string): Promise<boolean> {
  const seen = new Set<string>()
  let id = card.parentIssueId
  while (id !== null && !seen.has(id)) {
    if (id === ancestorId) {
      return true
    }
    seen.add(id)
    id = (await store.issues.findById(id))?.parentIssueId ?? null
  }
  return false
}

/** Is the card's own number already taken by another card in the target workspace? */
export async function numberTakenByAnother(store: BoardStore, workspaceId: string, card: Issue): Promise<boolean> {
  const holder = await store.issues.findByNumber(workspaceId, card.number)
  return holder !== null && holder.id !== card.id
}

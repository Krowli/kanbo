import { randomUUID } from 'node:crypto'

import type { BoardStore } from '../board-store'
import { BoardError } from '../domain/errors'
import { currentUnixSeconds } from '../domain/time'
import type { Issue, IssueComment, IssueFieldChange, IssueRun } from '../sqlite/schema'

/**
 * Who is acting on the board.
 *
 * Four kinds reach it: a person, an agent an app launched and knows, a provider
 * target standing in for one, and anything else — a command-line tool, a
 * script, an agent someone ran themselves. `id` is whatever the host calls that
 * actor, or `null` when it has no name to give; `chatSessionId` is the app's
 * chat session the action came from, and means nothing to a board written from
 * outside.
 */
export interface BoardActor {
  kind: 'user' | 'agent' | 'provider-target' | 'external'
  id: string | null
  name?: string
  chatSessionId?: string | null
  /**
   * A person's own terminal placing a card (ruling 6-6): the write is still
   * filed under `kind`/`id`, but a column's entry rules warn instead of
   * refusing, as they do for a person on the board page. Only the entry-rule check reads
   * it; it is never stored.
   */
  placesForPerson?: boolean
}

/**
 * The board writing on its own behalf: the lines and comments the board produces
 * from a run's lifecycle, which no person and no agent typed.
 *
 * This matters beyond provenance. Whether a failed run ends with "no report"
 * depends on the agent having written a status line since it started, so a line
 * the board wrote itself must never be filed under the agent that was running.
 */
export const BOARD_ACTOR: BoardActor = { kind: 'external', id: null }

/**
 * How an actor is stored on a comment or a field change. The board's four kinds
 * do not all exist in those columns: an outside writer is the system speaking,
 * while a provider target keeps its own kind, because an app's comment view
 * resolves it to the provider that wrote the comment.
 */
export function toStoredActorKind(actor: BoardActor): IssueFieldChange['actorKind'] {
  return actor.kind === 'external' ? 'system' : actor.kind
}

/**
 * How an actor is stored on a run. A run is launched by a person, by an agent,
 * or from outside; a provider target launches as the agent it stands in
 * for, because the run registry has no kind of its own for it.
 */
export function toRunLaunchedByKind(actor: BoardActor): IssueRun['launchedByKind'] {
  switch (actor.kind) {
    case 'user':
      return 'user'
    case 'agent':
    case 'provider-target':
      return 'agent'
    case 'external':
      return 'external'
  }
}

/** The card, or the error that says the board has no such card. */
export async function requireCard(store: BoardStore, issueId: string): Promise<Issue> {
  const card = await store.issues.findById(issueId)
  if (!card) {
    throw new BoardError('issue_not_found', { issueId })
  }
  return card
}

/**
 * Write what the card is doing right now, and record who said so.
 *
 * The column carries the current line; the field change carries its history,
 * and is the only place the actor and the time behind a line are kept — which is
 * what lets a reader tell a line the agent wrote from one the board wrote for
 * it. A line that says exactly what the card already says is not a change, and
 * writes nothing at all.
 */
export async function writeStatusLine(
  store: BoardStore,
  card: Issue,
  statusLine: string | null,
  actor: BoardActor,
): Promise<Issue> {
  if (card.statusLine === statusLine) {
    return card
  }

  const now = currentUnixSeconds()
  await store.issues.update(card.id, { statusLine, updatedAt: now })
  await store.fieldChanges.create({
    id: randomUUID(),
    issueId: card.id,
    field: 'statusLine',
    fromValue: card.statusLine,
    toValue: statusLine,
    actorKind: toStoredActorKind(actor),
    actorId: actor.id ?? null,
    sourceChatSessionId: actor.chatSessionId ?? null,
    createdAt: now,
  })
  return { ...card, statusLine, updatedAt: now }
}

/** A comment as the board writes it, before the row exists. */
export interface BoardCommentInput {
  issueId: string
  content: string
  authorKind: IssueComment['authorKind']
  authorId?: string | null
  sourceChatSessionId?: string | null
  agentActivityId?: string | null
  /**
   * The key that makes the comment a fact rather than a message: writing it
   * again with the same key leaves the first one standing.
   */
  dedupeKey?: string | null
}

export async function insertComment(store: BoardStore, input: BoardCommentInput): Promise<IssueComment> {
  const values = {
    id: randomUUID(),
    issueId: input.issueId,
    content: input.content,
    authorKind: input.authorKind,
    authorId: input.authorId ?? null,
    sourceChatSessionId: input.sourceChatSessionId ?? null,
    agentActivityId: input.agentActivityId ?? null,
    createdAt: currentUnixSeconds(),
  }

  if (input.dedupeKey == null) {
    return await store.comments.create(values)
  }
  return await store.comments.createOnce({ ...values, dedupeKey: input.dedupeKey })
}

import { randomUUID } from 'node:crypto'

import type { Issue, issueFieldChanges, issues } from '../sqlite/schema'
import type { IssueActorKind } from './issue-view'

/**
 * The issue columns whose edits are written to the audit trail.
 *
 * `statusLine` is absent on purpose: `writeStatusLine` records every line it
 * writes itself, and no patch ever carries the column. `waitingFor` is absent
 * too — whose turn it is shows in the card's own line and in the
 * `system.approved` / `system.returned` comments around it, so a row saying the
 * same thing a third time would only crowd the history.
 */
export const TRACKED_FIELDS = [
  'workspaceId',
  'title',
  'description',
  'priority',
  'labels',
  'milestoneId',
  'parentIssueId',
  'statusId',
  'assigneeKind',
  'assigneeId',
  'dueDate',
  'delegateAgentId',
  'delegateProviderTargetId',
  'contextRefs',
  'executionMode',
  'order',
] as const

/** Who an issue edit is attributed to, with the chat session it came from. */
export interface IssueMutationActor {
  kind: IssueActorKind
  id: string | null
  sourceChatSessionId?: string | null
}

/**
 * The audit rows one patch produces: a row per tracked field whose stringified
 * value actually changed. Nothing is written here — the caller inserts what
 * comes back, so the diff stays a pure function of the row, the patch, the
 * actor and the clock.
 */
export function diffFieldChanges(
  before: Issue,
  updates: Partial<typeof issues.$inferInsert>,
  actor: IssueMutationActor,
  now: number,
): Array<typeof issueFieldChanges.$inferInsert> {
  const rows: Array<typeof issueFieldChanges.$inferInsert> = []
  for (const field of TRACKED_FIELDS) {
    if (!(field in updates)) {
      continue
    }
    const dbField = field === 'labels' ? 'labels' : field
    const rawBefore = before[dbField as keyof Issue]
    const rawAfter = updates[field]
    const fromValue = rawBefore == null ? null : String(rawBefore)
    const toValue = rawAfter == null ? null : String(rawAfter)
    if (fromValue === toValue) {
      continue
    }
    rows.push({
      id: randomUUID(),
      issueId: before.id,
      field,
      fromValue,
      toValue,
      actorKind: actor.kind,
      actorId: actor.id ?? null,
      sourceChatSessionId: actor.sourceChatSessionId ?? null,
      createdAt: now,
    })
  }
  return rows
}

import type { BoardStore } from '../board-store'
import type {
  IssueActivityField,
  IssueActivityFieldChangeView,
  IssueActivityItemView,
  IssueActivityLookup,
  IssueActivityValueToken,
  IssueActivityValueView,
  IssueCommentAuthorView,
} from '../domain/activity-types'
import {
  activityKindOrder,
  activityText,
  activityToken,
  commentAuthorReference,
  formatActivityIssueReference,
  formatPlainActivityValue,
  isEmptyActivityValue,
  parseActivityStringArray,
  readSystemCommentKind,
} from '../domain/issue-activity'
import type { IssueActorReference } from '../domain/issue-view'
import type { IssueComment, IssueFieldChange } from '../sqlite/schema'
import { requireCard } from './types'

/**
 * What the host knows and the board does not: the names of its workspaces, who
 * an actor is, and what an agent is called. A board holds ids for all three and
 * nothing more, so an Activity feed is the board's rows read through these.
 */
export interface IssueActivityResolver {
  workspaceById: IssueActivityLookup['workspaceById']
  /** Who a reader sees beside a row. */
  resolveActor: (actor: IssueActorReference) => Promise<IssueCommentAuthorView>
  /** The agent's name, or `null` when the host has no such agent. */
  resolveAgentName: (agentId: string) => Promise<string | null>
}

/**
 * Field changes the feed keeps out of sight. `executionMode` is recorded and
 * readable through the field-change history — where a card runs is a fact about
 * the work — but the card itself already says it, so the feed does not repeat
 * it. `waitingFor` is listed for the same reason and is not recorded at all:
 * whose turn it is shows in the status line the card is handed over with, and in
 * the approval and return comments around it.
 */
const HIDDEN_ACTIVITY_FIELDS = new Set([
  'assigneeKind',
  'contextRefs',
  'delegateAgentId',
  'delegateProviderTargetId',
  'executionMode',
  'order',
  'waitingFor',
])

const ACTIVITY_FIELD_BY_RAW_FIELD: Record<string, IssueActivityField> = {
  assigneeId: 'assignee',
  description: 'description',
  dueDate: 'due-date',
  labels: 'labels',
  milestoneId: 'milestone',
  parentIssueId: 'parent',
  priority: 'priority',
  statusId: 'status',
  statusLine: 'status-line',
  title: 'title',
  workspaceId: 'workspace',
}

const PRIORITY_ACTIVITY_VALUE_TOKEN: Record<string, IssueActivityValueToken> = {
  none: 'priority-none',
  low: 'priority-low',
  medium: 'priority-medium',
  high: 'priority-high',
  urgent: 'priority-urgent',
}

/** The card's field history, oldest first — every tracked change, hidden ones included. */
export async function listFieldChanges(store: BoardStore, issueId: string): Promise<IssueFieldChange[]> {
  await requireCard(store, issueId)
  return await store.fieldChanges.listByIssue(issueId)
}

/**
 * The card's Activity feed: its creation, its visible field changes and its
 * comments, oldest first, with a creation before a change and a change before a
 * comment written in the same second.
 */
export async function listActivity(
  store: BoardStore,
  issueId: string,
  resolver: IssueActivityResolver,
): Promise<IssueActivityItemView[]> {
  const issue = await requireCard(store, issueId)
  const lookup: IssueActivityLookup = {
    issue,
    issueById: new Map((await store.issues.listAll()).map(row => [row.id, row])),
    milestoneById: new Map((await store.milestones.listAll()).map(row => [row.id, row])),
    statusById: new Map((await store.statuses.listAll()).map(row => [row.id, row])),
    workspaceById: resolver.workspaceById,
  }
  const commentItems = await Promise.all(
    (await store.comments.listByIssue(issueId)).map(async comment => await toCommentActivityItem(comment, resolver)),
  )
  const fieldChangeItems = (await Promise.all(
    (await store.fieldChanges.listByIssue(issueId)).map(async change => await toFieldChangeActivityItem(change, lookup, resolver)),
  ))
    .filter((item): item is IssueActivityItemView => item !== null)
  const createdItem: IssueActivityItemView = {
    id: `${issue.id}:created`,
    issueId: issue.id,
    kind: 'created',
    actor: await resolver.resolveActor({
      kind: issue.createdByKind,
      id: issue.createdById,
      sourceChatSessionId: issue.sourceChatSessionId,
    }),
    comment: null,
    fieldChange: null,
    sourceChatSessionId: issue.sourceChatSessionId,
    createdAt: issue.createdAt,
  }

  return [
    createdItem,
    ...fieldChangeItems,
    ...commentItems,
  ].toSorted((left, right) => left.createdAt - right.createdAt || activityKindOrder(left.kind) - activityKindOrder(right.kind))
}

async function toCommentActivityItem(comment: IssueComment, resolver: IssueActivityResolver): Promise<IssueActivityItemView> {
  return {
    id: comment.id,
    issueId: comment.issueId,
    kind: 'comment',
    actor: await resolver.resolveActor(commentAuthorReference(comment)),
    comment: {
      content: comment.content,
      systemKind: readSystemCommentKind(comment.authorKind, comment),
    },
    fieldChange: null,
    sourceChatSessionId: comment.sourceChatSessionId,
    createdAt: comment.createdAt,
  }
}

async function toFieldChangeActivityItem(
  change: IssueFieldChange,
  lookup: IssueActivityLookup,
  resolver: IssueActivityResolver,
): Promise<IssueActivityItemView | null> {
  if (HIDDEN_ACTIVITY_FIELDS.has(change.field)) {
    return null
  }

  const field = ACTIVITY_FIELD_BY_RAW_FIELD[change.field] ?? 'metadata'
  return {
    id: change.id,
    issueId: change.issueId,
    kind: 'field-change',
    actor: await resolver.resolveActor({
      kind: change.actorKind,
      id: change.actorId,
      sourceChatSessionId: change.sourceChatSessionId,
    }),
    comment: null,
    fieldChange: await formatActivityFieldChange(change, field, lookup, resolver),
    sourceChatSessionId: change.sourceChatSessionId,
    createdAt: change.createdAt,
  }
}

async function formatActivityFieldChange(
  change: IssueFieldChange,
  field: IssueActivityField,
  lookup: IssueActivityLookup,
  resolver: IssueActivityResolver,
): Promise<IssueActivityFieldChangeView> {
  if (field === 'description') {
    if (isEmptyActivityValue(change.fromValue) && !isEmptyActivityValue(change.toValue)) {
      return { action: 'added-description', field, fromValue: null, toValue: null }
    }
    if (!isEmptyActivityValue(change.fromValue) && isEmptyActivityValue(change.toValue)) {
      return { action: 'cleared-description', field, fromValue: null, toValue: null }
    }
    return { action: 'updated-description', field, fromValue: null, toValue: null }
  }

  return {
    action: field === 'title' ? 'renamed-issue' : 'changed-field',
    field,
    fromValue: await formatActivityFieldValue(field, change.fromValue, lookup, resolver),
    toValue: await formatActivityFieldValue(field, change.toValue, lookup, resolver),
  }
}

async function formatActivityFieldValue(
  field: IssueActivityField,
  value: string | null,
  lookup: IssueActivityLookup,
  resolver: IssueActivityResolver,
): Promise<IssueActivityValueView> {
  switch (field) {
    case 'assignee':
      if (isEmptyActivityValue(value)) {
        return activityToken('unassigned')
      }
      if (value === '__self__') {
        return activityToken('current-user')
      }
      return activityText(await resolver.resolveAgentName(value)) ?? activityToken('unknown-user')

    case 'due-date': {
      if (isEmptyActivityValue(value)) {
        return activityToken('no-due-date')
      }
      const timestamp = Number(value)
      if (!Number.isFinite(timestamp)) {
        return activityToken('changed')
      }
      return { kind: 'date', timestamp }
    }

    case 'labels': {
      const labels = parseActivityStringArray(value)
      if (!labels || labels.length === 0) {
        return activityToken('no-labels')
      }
      return { kind: 'text', text: labels.join(', ') }
    }

    case 'milestone':
      if (isEmptyActivityValue(value)) {
        return activityToken('no-milestone')
      }
      return activityText(lookup.milestoneById.get(value)?.title ?? null) ?? activityToken('unknown-milestone')

    case 'parent':
      if (isEmptyActivityValue(value)) {
        return activityToken('no-parent')
      }
      return formatActivityIssueReference(value, lookup)

    case 'priority':
      return activityToken(PRIORITY_ACTIVITY_VALUE_TOKEN[value ?? ''] ?? 'priority-none')

    case 'status':
      if (isEmptyActivityValue(value)) {
        return activityToken('no-status')
      }
      return activityText(lookup.statusById.get(value)?.name ?? null) ?? activityToken('unknown-status')

    case 'title':
      return formatPlainActivityValue(value)

    case 'workspace':
      if (isEmptyActivityValue(value)) {
        return activityToken('empty')
      }
      return activityText(lookup.workspaceById.get(value)?.name ?? null) ?? formatPlainActivityValue(value)

    default:
      return formatPlainActivityValue(value)
  }
}

import type { IssueActivityItemView } from '../../domain/activity-types'
import type { ServeCardView, ServeStatusView } from '../views'

/** An activity row as `GET /issues/:id/activity` answers it, with only what a test names changed. */
export function activityFixture(fields: Partial<IssueActivityItemView> & Pick<IssueActivityItemView, 'id'>): IssueActivityItemView {
  return {
    issueId: 'card',
    kind: 'field-change',
    actor: { kind: 'agent', id: 'claude', displayName: 'claude', avatarUrl: null, label: null },
    comment: null,
    fieldChange: null,
    sourceChatSessionId: null,
    createdAt: 0,
    ...fields,
  }
}

/** A column as `GET /issues/statuses` answers it, with only what a test names changed. */
export function statusFixture(fields: Partial<ServeStatusView> & Pick<ServeStatusView, 'id' | 'name'>): ServeStatusView {
  return {
    workspaceId: 'workspace',
    description: null,
    color: null,
    category: 'unstarted',
    order: 0,
    entryRules: [],
    createdAt: 0,
    ...fields,
  }
}

/** A card as `GET /issues` answers it, with only what a test names changed. */
export function cardFixture(fields: Partial<ServeCardView> & Pick<ServeCardView, 'id'>): ServeCardView {
  return {
    workspaceId: 'workspace',
    number: 1,
    statusId: 'todo',
    milestoneId: null,
    parentIssueId: null,
    title: fields.id,
    description: null,
    priority: 'none',
    labels: [],
    assigneeKind: null,
    assigneeId: null,
    dueDate: null,
    createdByKind: 'system',
    createdById: '__self__',
    sourceChatSessionId: null,
    delegateAgentId: null,
    delegateProviderTargetId: null,
    contextRefs: '[]',
    statusLine: null,
    waitingFor: null,
    executionMode: 'worktree',
    order: 0,
    createdAt: 0,
    updatedAt: 0,
    attemptCount: 0,
    activeRun: null,
    ...fields,
  }
}

import type { ServeCardView, ServeStatusView } from '../views'

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

import type { Issue, IssueMilestone, IssueStatus } from '../sqlite/schema'
import type { IssueActorKind } from './issue-view'
import type { BoardWorkspaceIdentity } from './numbering'

export type IssueActivityValueToken
  = | 'changed'
    | 'current-user'
    | 'empty'
    | 'no-due-date'
    | 'no-labels'
    | 'no-milestone'
    | 'no-parent'
    | 'no-status'
    | 'priority-high'
    | 'priority-low'
    | 'priority-medium'
    | 'priority-none'
    | 'priority-urgent'
    | 'unassigned'
    | 'unknown-issue'
    | 'unknown-milestone'
    | 'unknown-status'
    | 'unknown-user'

export type IssueActivityValueView
  = | { kind: 'date', timestamp: number }
    | { kind: 'text', text: string }
    | { kind: 'token', token: IssueActivityValueToken }

export type IssueActivityField
  = | 'assignee'
    | 'description'
    | 'due-date'
    | 'labels'
    | 'metadata'
    | 'milestone'
    | 'parent'
    | 'priority'
    | 'status'
    | 'status-line'
    | 'title'
    | 'workspace'

export type IssueActivityAction
  = | 'added-description'
    | 'changed-field'
    | 'cleared-description'
    | 'renamed-issue'
    | 'updated-description'

export interface IssueActivityFieldChangeView {
  action: IssueActivityAction
  field: IssueActivityField | null
  fromValue: IssueActivityValueView | null
  toValue: IssueActivityValueView | null
}

export interface IssueActivityCommentView {
  content: string
  systemKind: 'delegated' | 'system' | 'undelegated' | null
}

/** The actor a board shows beside a comment or an activity row. */
export interface IssueCommentAuthorView {
  kind: IssueActorKind
  id: string | null
  displayName: string
  avatarUrl: string | null
  label: string | null
}

export interface IssueActivityItemView {
  id: string
  issueId: string
  kind: 'comment' | 'created' | 'field-change'
  actor: IssueCommentAuthorView
  comment: IssueActivityCommentView | null
  fieldChange: IssueActivityFieldChangeView | null
  sourceChatSessionId: string | null
  createdAt: number
}

/**
 * The rows an Activity projection resolves ids against, read once per issue so
 * formatting a change never goes back to the store.
 */
export interface IssueActivityLookup {
  issue: Issue
  issueById: Map<string, Pick<Issue, 'id' | 'title'>>
  milestoneById: Map<string, Pick<IssueMilestone, 'id' | 'title'>>
  statusById: Map<string, Pick<IssueStatus, 'id' | 'name'>>
  workspaceById: Map<string, Pick<BoardWorkspaceIdentity, 'id' | 'name'>>
}

import { sql } from 'drizzle-orm'
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import { index, int, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

/**
 * The board, as a SQLite file holds it.
 *
 * These nine tables are the board itself, and this package owns them: the same
 * logical schema as `src/postgres/schema.ts`, written for the dialect a file
 * speaks. They live in three different places at runtime — a host app's own
 * database, a board file of a project's own, and neither of those when the
 * board is a Postgres database — and none of those homes owns the shape. A host
 * app re-exports these very objects from its own schema, so its tables and
 * these are the same tables rather than two declarations that have to be kept
 * in step.
 *
 * **Every reference out of the board is a plain text column** (ruling 5-1).
 * `workspace_id`, `delegate_agent_id`, `delegate_provider_target_id` and
 * `source_chat_session_id` name rows in a host app's tables, and a board file of
 * a project's own has no such tables to point at — so they are soft references
 * into whichever app is looking, exactly as they are on Postgres. What an
 * `ON DELETE` would do is done in the open by the app that deletes the row: it
 * empties a removed workspace's board, and clears the delegation off the cards
 * that named a removed agent or provider target. The foreign keys that stay are the
 * ones that point *inside* the board, and they still cascade.
 */

const textPk = () => text('id').primaryKey()

const timestamps = () => ({
  createdAt: int('created_at').notNull().default(sql`(unixepoch())`),
  updatedAt: int('updated_at').notNull().default(sql`(unixepoch())`),
})

const createdAt = () => ({
  createdAt: int('created_at').notNull().default(sql`(unixepoch())`),
})

export const issueStatuses = sqliteTable('issue_statuses', {
  id: textPk(),
  workspaceId: text('workspace_id').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  color: text('color'),
  category: text('category', { enum: ['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled'] }).notNull().default('unstarted'),
  order: int('order').notNull().default(0),
  /**
   * What a card must satisfy before an agent may put it in this column — a JSON
   * array of `ENTRY_RULES` (ruling 6-1); `null` asks for nothing. Read it
   * through `readEntryRules`, never by hand.
   */
  entryRules: text('entry_rules'),
  ...createdAt(),
}, table => ({
  byWorkspace: index('issue_statuses_workspace_id_idx').on(table.workspaceId),
  byWorkspaceName: uniqueIndex('issue_statuses_workspace_name_unique').on(table.workspaceId, table.name),
}))

export const issueMilestones = sqliteTable('issue_milestones', {
  id: textPk(),
  workspaceId: text('workspace_id').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  /** When the milestone, read as a sprint, begins (unix seconds); null for a plain milestone. */
  startDate: int('start_date'),
  dueDate: int('due_date'),
  status: text('status', { enum: ['open', 'closed'] }).notNull().default('open'),
  ...timestamps(),
}, table => ({
  byWorkspace: index('issue_milestones_workspace_id_idx').on(table.workspaceId),
}))

export const issues = sqliteTable('issues', {
  id: textPk(),
  workspaceId: text('workspace_id').notNull(),
  number: int('number').notNull(),
  statusId: text('status_id').references(() => issueStatuses.id, { onDelete: 'set null' }),
  milestoneId: text('milestone_id').references(() => issueMilestones.id, { onDelete: 'set null' }),
  parentIssueId: text('parent_issue_id')
    .references((): AnySQLiteColumn => issues.id, { onDelete: 'set null' }),
  title: text('title').notNull(),
  description: text('description'),
  priority: text('priority', {
    enum: ['none', 'low', 'medium', 'high', 'urgent'],
  }).notNull().default('none'),
  labels: text('labels').notNull().default('[]'),
  assigneeKind: text('assignee_kind'),
  assigneeId: text('assignee_id'),
  dueDate: int('due_date'),
  createdByKind: text('created_by_kind', { enum: ['user', 'agent', 'system', 'provider-target'] }).notNull().default('user'),
  createdById: text('created_by_id').notNull().default('__self__'),
  sourceChatSessionId: text('source_chat_session_id'),
  delegateAgentId: text('delegate_agent_id'),
  delegateProviderTargetId: text('delegate_provider_target_id'),
  contextRefs: text('context_refs').notNull().default('[]'),
  statusLine: text('status_line'),
  waitingFor: text('waiting_for', { enum: ['human'] }),
  executionMode: text('execution_mode', { enum: ['worktree', 'main'] }).notNull().default('worktree'),
  order: int('order').notNull().default(0),
  ...timestamps(),
}, table => ({
  byWorkspace: index('issues_workspace_id_idx').on(table.workspaceId),
  byWorkspaceNumber: uniqueIndex('issues_workspace_number_unique').on(table.workspaceId, table.number),
  byStatus: index('issues_status_id_idx').on(table.statusId),
  byMilestone: index('issues_milestone_id_idx').on(table.milestoneId),
  byParent: index('issues_parent_issue_id_idx').on(table.parentIssueId),
  byDelegateAgent: index('issues_delegate_agent_id_idx').on(table.delegateAgentId),
  byDelegateProviderTarget: index('issues_delegate_provider_target_id_idx').on(table.delegateProviderTargetId),
}))

export const issueComments = sqliteTable('issue_comments', {
  id: textPk(),
  issueId: text('issue_id')
    .notNull()
    .references(() => issues.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
  authorKind: text('author_kind', {
    enum: [
      'user',
      'agent',
      'provider-target',
      'system',
      'system.delegated',
      'system.undelegated',
      'system.run',
      'system.approved',
      'system.returned',
      'system.pr',
    ],
  }).notNull().default('user'),
  authorId: text('author_id'),
  sourceChatSessionId: text('source_chat_session_id'),
  agentActivityId: text('agent_activity_id'),
  dedupeKey: text('dedupe_key'),
  ...createdAt(),
}, table => ({
  byIssue: index('issue_comments_issue_id_idx').on(table.issueId),
  byIssueDedupeKey: uniqueIndex('issue_comments_issue_dedupe_idx').on(table.issueId, table.dedupeKey),
}))

export const issueRuns = sqliteTable('issue_runs', {
  id: textPk(),
  issueId: text('issue_id')
    .notNull()
    .references(() => issues.id, { onDelete: 'cascade' }),
  launchedByKind: text('launched_by_kind', { enum: ['user', 'agent', 'external'] }).notNull().default('user'),
  launchedById: text('launched_by_id'),
  agentId: text('agent_id'),
  agentName: text('agent_name').notNull(),
  host: text('host'),
  executionMode: text('execution_mode', { enum: ['worktree', 'main'] }).notNull().default('worktree'),
  branch: text('branch'),
  worktreePath: text('worktree_path'),
  state: text('state', { enum: ['running', 'finished', 'failed', 'stopped'] }).notNull().default('running'),
  chatSessionId: text('chat_session_id'),
  /** Where an external agent's own log of this run lives — `claude:<id>` or `codex:<id>` (ruling 7-1), `null` when it never said. */
  externalSessionRef: text('external_session_ref'),
  startedAt: int('started_at').notNull().default(sql`(unixepoch())`),
  endedAt: int('ended_at'),
}, table => ({
  byIssue: index('issue_runs_issue_id_idx').on(table.issueId),
  byIssueState: index('issue_runs_issue_state_idx').on(table.issueId, table.state),
  byChatSession: index('issue_runs_chat_session_idx').on(table.chatSessionId),
}))

export const issueRelations = sqliteTable('issue_relations', {
  id: textPk(),
  sourceIssueId: text('source_issue_id')
    .notNull()
    .references(() => issues.id, { onDelete: 'cascade' }),
  targetIssueId: text('target_issue_id')
    .notNull()
    .references(() => issues.id, { onDelete: 'cascade' }),
  type: text('type', { enum: ['blocks', 'duplicates', 'relates_to'] }).notNull(),
  ...createdAt(),
}, table => ({
  bySource: index('issue_relations_source_issue_id_idx').on(table.sourceIssueId),
  byTarget: index('issue_relations_target_issue_id_idx').on(table.targetIssueId),
  byPairType: uniqueIndex('issue_relations_pair_type_unique')
    .on(table.sourceIssueId, table.targetIssueId, table.type),
}))

export const issueFieldChanges = sqliteTable('issue_field_changes', {
  id: textPk(),
  issueId: text('issue_id')
    .notNull()
    .references(() => issues.id, { onDelete: 'cascade' }),
  field: text('field').notNull(),
  fromValue: text('from_value'),
  toValue: text('to_value'),
  actorKind: text('actor_kind', { enum: ['user', 'agent', 'provider-target', 'system'] }).notNull().default('user'),
  actorId: text('actor_id'),
  sourceChatSessionId: text('source_chat_session_id'),
  ...createdAt(),
}, table => ({
  byIssue: index('issue_field_changes_issue_id_idx').on(table.issueId),
}))

/**
 * A pull request someone said belongs to a card.
 *
 * The link is the board's; what the pull request *is* — open, merged, green —
 * is GitHub's, and the board keeps none of it. Whoever watches GitHub reads the
 * links here and writes what it saw as comments on the card, so this row is a
 * name (`owner/repo#number`, and the URL it came from) and who gave it. One
 * card names one pull request once; the same pull request may belong to several
 * cards, which is why `(owner, repo, number)` is indexed on its own.
 */
export const issuePullRequests = sqliteTable('issue_pull_requests', {
  id: textPk(),
  issueId: text('issue_id')
    .notNull()
    .references(() => issues.id, { onDelete: 'cascade' }),
  owner: text('owner').notNull(),
  repo: text('repo').notNull(),
  number: int('number').notNull(),
  url: text('url').notNull(),
  createdByKind: text('created_by_kind', { enum: ['user', 'agent', 'provider-target', 'system'] }).notNull(),
  createdById: text('created_by_id'),
  ...createdAt(),
}, table => ({
  byIssuePullRequest: uniqueIndex('issue_pull_requests_issue_pr_unique')
    .on(table.issueId, table.owner, table.repo, table.number),
  byPullRequest: index('issue_pull_requests_pr_idx').on(table.owner, table.repo, table.number),
}))

/**
 * Monotonic counters the board keeps for its readers: `board` is bumped by the
 * board operations layer once per write transaction that changed something, so a
 * poller can tell a changed board from an unchanged one, and `schema_epoch`
 * records the board schema generation the file was written with.
 */
export const kanbanMeta = sqliteTable('kanban_meta', {
  key: text('key').primaryKey(),
  revision: int('revision').notNull().default(0),
  updatedAt: int('updated_at').notNull().default(sql`(unixepoch())`),
})

export type IssueStatus = typeof issueStatuses.$inferSelect
export type IssueMilestone = typeof issueMilestones.$inferSelect
export type Issue = typeof issues.$inferSelect
export type IssueComment = typeof issueComments.$inferSelect
export type IssueRun = typeof issueRuns.$inferSelect
export type IssueRelation = typeof issueRelations.$inferSelect
export type IssueFieldChange = typeof issueFieldChanges.$inferSelect
export type IssuePullRequest = typeof issuePullRequests.$inferSelect
export type KanbanMeta = typeof kanbanMeta.$inferSelect

/** Every table of the board, in the order a reader of the schema wants them. */
export const boardSqliteSchema = {
  issueStatuses,
  issueMilestones,
  issues,
  issueComments,
  issueRuns,
  issueRelations,
  issueFieldChanges,
  issuePullRequests,
  kanbanMeta,
}

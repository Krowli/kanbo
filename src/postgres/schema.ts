import { sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { bigint, bigserial, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core'

/**
 * The board, as a Postgres database holds it.
 *
 * This is the same logical schema as `src/sqlite/schema.ts` — same column
 * names, same nullability, same enum members, same index names — written for a
 * second dialect rather than a second design. The store reads and writes both
 * through one `BoardStore` interface, so anything that drifts here shows up as
 * a card that reads differently depending on where its board lives.
 *
 * Two deliberate differences from the SQLite file:
 *
 * - **Unix seconds are `bigint`, read as `number`.** SQLite stores them in an
 *   `integer` wide enough for them; Postgres's `integer` is 32-bit, and
 *   `mode: 'number'` keeps the value a JavaScript number so the store hands
 *   `ops` and `domain` exactly what the SQLite store hands them.
 * - **`seq` on `issue_runs`, `issue_comments`, `issue_field_changes` and
 *   `issue_pull_requests`.**
 *   SQLite orders those four by `rowid` — insertion order, which two rows
 *   written in the same second still separate. Postgres has no `rowid`, and its
 *   heap order is free to change (a row written last can land in the slot a
 *   deleted one freed), so the board carries its own order: a `bigserial` those
 *   queries order by, and the only columns here that have no SQLite
 *   counterpart.
 *
 * What used to be a third difference is one no longer: `workspace_id`,
 * `delegate_agent_id`, `delegate_provider_target_id` and
 * `source_chat_session_id` are plain text here *and* in the file (ruling 5-1),
 * because a database holding only the board was never the only home without a
 * `workspaces` table to point at.
 *
 * `labels` and `context_refs` stay `text` holding JSON rather than becoming
 * `jsonb`: they are encoded and decoded above the store, and a second
 * representation would be a second thing to keep in step for nothing.
 */

/** `unixepoch()` in the dialect that has no such function. */
const unixNow = sql`(extract(epoch from now())::bigint)`

const textPk = () => text('id').primaryKey()

const createdAt = () => ({
  createdAt: bigint('created_at', { mode: 'number' }).notNull().default(unixNow),
})

const timestamps = () => ({
  ...createdAt(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull().default(unixNow),
})

export const issueStatuses = pgTable('issue_statuses', {
  id: textPk(),
  workspaceId: text('workspace_id').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  color: text('color'),
  category: text('category', { enum: ['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled'] }).notNull().default('unstarted'),
  order: integer('order').notNull().default(0),
  /** A JSON array of `ENTRY_RULES`, or `null` for none — see the SQLite schema. */
  entryRules: text('entry_rules'),
  ...createdAt(),
}, table => [
  index('issue_statuses_workspace_id_idx').on(table.workspaceId),
  uniqueIndex('issue_statuses_workspace_name_unique').on(table.workspaceId, table.name),
])

export const issueMilestones = pgTable('issue_milestones', {
  id: textPk(),
  workspaceId: text('workspace_id').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  /** When the milestone, read as a sprint, begins (unix seconds); null for a plain milestone. */
  startDate: bigint('start_date', { mode: 'number' }),
  dueDate: bigint('due_date', { mode: 'number' }),
  status: text('status', { enum: ['open', 'closed'] }).notNull().default('open'),
  ...timestamps(),
}, table => [
  index('issue_milestones_workspace_id_idx').on(table.workspaceId),
])

export const issues = pgTable('issues', {
  id: textPk(),
  workspaceId: text('workspace_id').notNull(),
  number: integer('number').notNull(),
  statusId: text('status_id').references(() => issueStatuses.id, { onDelete: 'set null' }),
  milestoneId: text('milestone_id').references(() => issueMilestones.id, { onDelete: 'set null' }),
  parentIssueId: text('parent_issue_id')
    .references((): AnyPgColumn => issues.id, { onDelete: 'set null' }),
  title: text('title').notNull(),
  description: text('description'),
  priority: text('priority', {
    enum: ['none', 'low', 'medium', 'high', 'urgent'],
  }).notNull().default('none'),
  labels: text('labels').notNull().default('[]'),
  assigneeKind: text('assignee_kind'),
  assigneeId: text('assignee_id'),
  dueDate: bigint('due_date', { mode: 'number' }),
  createdByKind: text('created_by_kind', { enum: ['user', 'agent', 'system', 'provider-target'] }).notNull().default('user'),
  createdById: text('created_by_id').notNull().default('__self__'),
  sourceChatSessionId: text('source_chat_session_id'),
  delegateAgentId: text('delegate_agent_id'),
  delegateProviderTargetId: text('delegate_provider_target_id'),
  contextRefs: text('context_refs').notNull().default('[]'),
  statusLine: text('status_line'),
  waitingFor: text('waiting_for', { enum: ['human'] }),
  executionMode: text('execution_mode', { enum: ['worktree', 'main'] }).notNull().default('worktree'),
  order: integer('order').notNull().default(0),
  ...timestamps(),
}, table => [
  index('issues_workspace_id_idx').on(table.workspaceId),
  uniqueIndex('issues_workspace_number_unique').on(table.workspaceId, table.number),
  index('issues_status_id_idx').on(table.statusId),
  index('issues_milestone_id_idx').on(table.milestoneId),
  index('issues_parent_issue_id_idx').on(table.parentIssueId),
  index('issues_delegate_agent_id_idx').on(table.delegateAgentId),
  index('issues_delegate_provider_target_id_idx').on(table.delegateProviderTargetId),
])

export const issueComments = pgTable('issue_comments', {
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
  /** Insertion order, standing in for the `rowid` the SQLite board orders comments by. */
  seq: bigserial('seq', { mode: 'number' }).notNull(),
}, table => [
  index('issue_comments_issue_id_idx').on(table.issueId),
  uniqueIndex('issue_comments_issue_dedupe_idx').on(table.issueId, table.dedupeKey),
])

export const issueRuns = pgTable('issue_runs', {
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
  startedAt: bigint('started_at', { mode: 'number' }).notNull().default(unixNow),
  endedAt: bigint('ended_at', { mode: 'number' }),
  /** Insertion order, standing in for the `rowid` the SQLite board orders runs by. */
  seq: bigserial('seq', { mode: 'number' }).notNull(),
}, table => [
  index('issue_runs_issue_id_idx').on(table.issueId),
  index('issue_runs_issue_state_idx').on(table.issueId, table.state),
  index('issue_runs_chat_session_idx').on(table.chatSessionId),
])

export const issueRelations = pgTable('issue_relations', {
  id: textPk(),
  sourceIssueId: text('source_issue_id')
    .notNull()
    .references(() => issues.id, { onDelete: 'cascade' }),
  targetIssueId: text('target_issue_id')
    .notNull()
    .references(() => issues.id, { onDelete: 'cascade' }),
  type: text('type', { enum: ['blocks', 'duplicates', 'relates_to'] }).notNull(),
  ...createdAt(),
}, table => [
  index('issue_relations_source_issue_id_idx').on(table.sourceIssueId),
  index('issue_relations_target_issue_id_idx').on(table.targetIssueId),
  uniqueIndex('issue_relations_pair_type_unique')
    .on(table.sourceIssueId, table.targetIssueId, table.type),
])

export const issueFieldChanges = pgTable('issue_field_changes', {
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
  /** Insertion order, standing in for the `rowid` the SQLite board orders changes by. */
  seq: bigserial('seq', { mode: 'number' }).notNull(),
}, table => [
  index('issue_field_changes_issue_id_idx').on(table.issueId),
])

/** A pull request someone said belongs to a card — see the SQLite twin for what the row is and is not. */
export const issuePullRequests = pgTable('issue_pull_requests', {
  id: textPk(),
  issueId: text('issue_id')
    .notNull()
    .references(() => issues.id, { onDelete: 'cascade' }),
  owner: text('owner').notNull(),
  repo: text('repo').notNull(),
  number: integer('number').notNull(),
  url: text('url').notNull(),
  createdByKind: text('created_by_kind', { enum: ['user', 'agent', 'provider-target', 'system'] }).notNull(),
  createdById: text('created_by_id'),
  ...createdAt(),
  /** Insertion order, standing in for the `rowid` the SQLite board orders a card's links by. */
  seq: bigserial('seq', { mode: 'number' }).notNull(),
}, table => [
  uniqueIndex('issue_pull_requests_issue_pr_unique')
    .on(table.issueId, table.owner, table.repo, table.number),
  index('issue_pull_requests_pr_idx').on(table.owner, table.repo, table.number),
])

/**
 * The counters the board keeps for its readers, exactly as the SQLite file
 * keeps them: `board` is bumped once per write transaction that changed
 * something, and `schema_epoch` records the generation the board was created
 * with.
 */
export const kanbanMeta = pgTable('kanban_meta', {
  key: text('key').primaryKey(),
  revision: integer('revision').notNull().default(0),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull().default(unixNow),
})

/** Every table of the board, in the order a reader of the schema wants them. */
export const boardPostgresSchema = {
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

/** The table names a Postgres board must carry, for the guard that refuses a database without them. */
export const BOARD_POSTGRES_TABLES = [
  'issue_statuses',
  'issue_milestones',
  'issues',
  'issue_comments',
  'issue_runs',
  'issue_relations',
  'issue_field_changes',
  'issue_pull_requests',
  'kanban_meta',
] as const

import type { BoardStore } from '../../board-store'
import type { BoardMetricsHistory, BoardMetricsInput } from '../../ops/board-metrics'
import type { ColumnEntry } from '../../ops/column-entries'
import type { Issue, IssueComment, IssueMilestone, IssueRun, IssueStatus } from '../../sqlite/schema'

/**
 * A board history with known answers (plan 012, Task 3). Day 0 is Monday
 * 2025-12-29, the first day of ISO week 2026-W01; now is day 24 at noon,
 * Thursday 2026-01-22.
 *
 * | card    | what happens (day, hour)                                    | cycle   | lead    |
 * |---------|-------------------------------------------------------------|---------|---------|
 * | WOR-001 | To Do 0/9 → In Progress 1/9 → In Review 2/9 → Done 3/9      | 172 800 | 259 200 |
 * | WOR-002 | To Do 0/10 → IP 2/10 → IR 4/10 → returned to IP 5/10 → IR 7/10 → Done 8/10 | 518 400 | 691 200 |
 * | WOR-003 | To Do 7/9 → IP 7/12 → IR 8/12 → Done 9/12 → reopened IP 10/12 (outside kanbo) → IR 12/12 → Done 14/12 | 604 800 | 615 600 |
 * | WOR-004 | To Do 1/9 → IP 2/9 → Canceled 4/9                           | canceled |        |
 * | WOR-005 | Backlog 2/9 → To Do 3/9 → IP 4/9, still there               | aging 1 738 800 |  |
 * | WOR-006 | created by an agent in To Do 20/9 → IP 21/9 → IR 23/9       | aging 270 000 |    |
 * | WOR-007 | To Do 10/9 → IP 11/9 → Done at the last second of day 13 (Sunday, 2026-W02) | 226 799 | 313 199 |
 * | WOR-008 | To Do 12/9 → IP 12/10 → IR 13/9 → sent back to To Do 13/12 (Tester) → IP 13/13 → IR 13/15 → Done at 00:00 of day 14 (Monday, 2026-W03) | 136 800 | 140 400 |
 * | WOR-009 | done on day -3, before the range                            | —       | —       |
 *
 * WOR-001…003 are in the milestone `sprint-1`. Approvals: WOR-001 (3/8) and
 * WOR-002 (8/9) by `__self__`, WOR-008 (13/23) by `alice`. Returns, moves back
 * into an earlier unstarted or started column (R012-7): WOR-002 by a person
 * (5/10), WOR-003 by an outside kanbo, `ci-watch` (10/12), WOR-008 by the
 * Tester agent `agent-codex` (13/12). Runs are listed in `runs` below. WOR-006, 007 and 008 were
 * created under 0.5.0 and carry their creation as `null → To Do`; the others
 * were created before it and carry none — both must read the same.
 */

export const METRICS_WORKSPACE = 'workspace'
const HOUR = 3_600
/** Monday 2025-12-29 00:00 UTC — the first second of ISO week 2026-W01. */
const WEEK_ONE = 1_766_966_400

/** `hours` past midnight UTC of day `n`, day 0 being Monday 2025-12-29. */
export function day(n: number, hours = 0): number {
  return WEEK_ONE + n * 86_400 + hours * HOUR
}

/** Thursday 2026-01-22, 12:00 UTC. */
export const METRICS_NOW = day(24, 12)

const BACKLOG = 'status-backlog'
const TODO = 'status-todo'
const PROGRESS = 'status-progress'
const REVIEW = 'status-review'
const DONE = 'status-done'
const CANCELED = 'status-canceled'

const PERSON = { actorKind: 'user', actorId: '__self__' } as const
const CLAUDE = { actorKind: 'agent', actorId: 'agent-claude' } as const
const TESTER = { actorKind: 'agent', actorId: 'agent-codex' } as const
/** An outside `kanbo` (a CI script) — stored as the system with a name. */
const OUTSIDE = { actorKind: 'system', actorId: 'ci-watch' } as const

function status(id: string, name: string, category: IssueStatus['category'], order: number, wipLimit: number | null = null): IssueStatus {
  return { id, workspaceId: METRICS_WORKSPACE, name, description: null, color: null, category, order, entryRules: null, allowedFrom: null, wipLimit, createdAt: day(-10) }
}

function card(number: number, statusId: string, createdAt: number, extra: Partial<Issue> = {}): Issue {
  return {
    id: `WOR-${String(number).padStart(3, '0')}`,
    workspaceId: METRICS_WORKSPACE,
    number,
    statusId,
    milestoneId: null,
    parentIssueId: null,
    title: `Card ${number}`,
    description: null,
    priority: 'none',
    labels: '[]',
    assigneeKind: null,
    assigneeId: null,
    dueDate: null,
    createdByKind: 'user',
    createdById: '__self__',
    sourceChatSessionId: null,
    delegateAgentId: null,
    delegateProviderTargetId: null,
    contextRefs: '[]',
    statusLine: null,
    waitingFor: null,
    executionMode: 'worktree',
    order: number,
    createdAt,
    updatedAt: createdAt,
    ...extra,
  }
}

let changeCount = 0
function move(issueId: string, fromStatusId: string | null, toStatusId: string, at: number, actor: Pick<ColumnEntry, 'actorKind' | 'actorId'> = PERSON): ColumnEntry {
  changeCount++
  return { changeId: `change-${String(changeCount).padStart(2, '0')}`, issueId, workspaceId: METRICS_WORKSPACE, fromStatusId, toStatusId, actorKind: actor.actorKind, actorId: actor.actorId, at }
}

function run(id: string, issueId: string, agent: 'claude' | 'codex' | 'gemini', state: IssueRun['state'], startedAt: number, endedAt: number | null): IssueRun {
  return {
    id,
    issueId,
    launchedByKind: 'user',
    launchedById: '__self__',
    // gemini was started from outside a host: no agent id, only a name.
    agentId: agent === 'gemini' ? null : `agent-${agent}`,
    agentName: agent,
    host: null,
    executionMode: 'worktree',
    branch: null,
    worktreePath: null,
    state,
    chatSessionId: `session-${id}`,
    externalSessionRef: null,
    startedAt,
    endedAt,
  }
}

function approval(id: string, issueId: string, authorId: string, createdAt: number): IssueComment {
  return { id, issueId, content: 'Approved', authorKind: 'system.approved', authorId, sourceChatSessionId: null, agentActivityId: null, dedupeKey: null, createdAt }
}

/** What `returnCard` writes beside its move back (WOR-002, 5/10): the metrics count the move, never this comment. */
export const METRICS_RETURN_COMMENT: IssueComment = {
  id: 'comment-2',
  issueId: 'WOR-002',
  content: 'Tests fail on Windows',
  authorKind: 'system.returned',
  authorId: '__self__',
  sourceChatSessionId: null,
  agentActivityId: null,
  dedupeKey: null,
  createdAt: day(5, 10),
}

export const METRICS_SPRINT: IssueMilestone = {
  id: 'sprint-1',
  workspaceId: METRICS_WORKSPACE,
  title: 'Sprint 1',
  description: null,
  startDate: day(0),
  dueDate: day(14) - 1,
  status: 'open',
  createdAt: day(-1),
  updatedAt: day(-1),
}

export const METRICS_HISTORY: BoardMetricsHistory = {
  statuses: [
    status(BACKLOG, 'Backlog', 'backlog', 0),
    status(TODO, 'To Do', 'unstarted', 1),
    status(PROGRESS, 'In Progress', 'started', 2, 2),
    status(REVIEW, 'In Review', 'started', 3),
    status(DONE, 'Done', 'completed', 4),
    status(CANCELED, 'Canceled', 'canceled', 5),
  ],
  milestones: [METRICS_SPRINT],
  cards: [
    card(1, DONE, day(0, 9), { milestoneId: METRICS_SPRINT.id }),
    card(2, DONE, day(0, 10), { milestoneId: METRICS_SPRINT.id }),
    card(3, DONE, day(7, 9), { milestoneId: METRICS_SPRINT.id }),
    card(4, CANCELED, day(1, 9)),
    card(5, PROGRESS, day(2, 9)),
    card(6, REVIEW, day(20, 9), { createdByKind: 'agent', createdById: 'agent-codex' }),
    card(7, DONE, day(10, 9)),
    card(8, DONE, day(12, 9)),
    card(9, DONE, day(-5, 9)),
  ],
  entries: [
    move('WOR-001', TODO, PROGRESS, day(1, 9), CLAUDE),
    move('WOR-001', PROGRESS, REVIEW, day(2, 9), CLAUDE),
    move('WOR-001', REVIEW, DONE, day(3, 9)),
    move('WOR-002', TODO, PROGRESS, day(2, 10), CLAUDE),
    move('WOR-002', PROGRESS, REVIEW, day(4, 10), CLAUDE),
    // A person's Return: one move back (METRICS_RETURN_COMMENT is written beside it, and not counted).
    move('WOR-002', REVIEW, PROGRESS, day(5, 10)),
    move('WOR-002', PROGRESS, REVIEW, day(7, 10), CLAUDE),
    move('WOR-002', REVIEW, DONE, day(8, 10)),
    move('WOR-003', TODO, PROGRESS, day(7, 12), CLAUDE),
    move('WOR-003', PROGRESS, REVIEW, day(8, 12), CLAUDE),
    move('WOR-003', REVIEW, DONE, day(9, 12)),
    // Reopened by an outside kanbo: Done → In Progress is a move back into a started column, so a return.
    move('WOR-003', DONE, PROGRESS, day(10, 12), OUTSIDE),
    move('WOR-003', PROGRESS, REVIEW, day(12, 12), CLAUDE),
    move('WOR-003', REVIEW, DONE, day(14, 12)),
    move('WOR-004', TODO, PROGRESS, day(2, 9), CLAUDE),
    move('WOR-004', PROGRESS, CANCELED, day(4, 9)),
    move('WOR-005', BACKLOG, TODO, day(3, 9)),
    move('WOR-005', TODO, PROGRESS, day(4, 9), CLAUDE),
    // Created under 0.5.0, by an agent: the creation is an entry from no column.
    move('WOR-006', null, TODO, day(20, 9), { actorKind: 'agent', actorId: 'agent-codex' }),
    move('WOR-006', TODO, PROGRESS, day(21, 9), CLAUDE),
    move('WOR-006', PROGRESS, REVIEW, day(23, 9), CLAUDE),
    move('WOR-007', null, TODO, day(10, 9)),
    move('WOR-007', TODO, PROGRESS, day(11, 9), CLAUDE),
    move('WOR-007', PROGRESS, DONE, day(14) - 1),
    move('WOR-008', null, TODO, day(12, 9)),
    move('WOR-008', TODO, PROGRESS, day(12, 10), CLAUDE),
    move('WOR-008', PROGRESS, REVIEW, day(13, 9), CLAUDE),
    // The Tester sends it back to To Do with failures, and the developer takes it again.
    move('WOR-008', REVIEW, TODO, day(13, 12), TESTER),
    move('WOR-008', TODO, PROGRESS, day(13, 13), CLAUDE),
    move('WOR-008', PROGRESS, REVIEW, day(13, 15), CLAUDE),
    move('WOR-008', REVIEW, DONE, day(14)),
    move('WOR-009', TODO, PROGRESS, day(-4, 9), CLAUDE),
    move('WOR-009', PROGRESS, DONE, day(-3, 9)),
  ],
  runs: [
    run('run-01', 'WOR-001', 'claude', 'finished', day(1, 9), day(2, 9)),
    run('run-02', 'WOR-002', 'claude', 'finished', day(2, 10), day(4, 10)),
    run('run-03', 'WOR-002', 'codex', 'failed', day(5, 11), day(5, 12)),
    run('run-04', 'WOR-002', 'codex', 'finished', day(6, 10), day(7, 10)),
    run('run-05', 'WOR-003', 'claude', 'finished', day(7, 12), day(8, 12)),
    run('run-06', 'WOR-003', 'claude', 'finished', day(10, 12), day(12, 12)),
    run('run-07', 'WOR-004', 'claude', 'stopped', day(2, 9), day(3, 9)),
    run('run-08', 'WOR-005', 'claude', 'running', day(4, 9), null),
    run('run-09', 'WOR-006', 'codex', 'finished', day(21, 9), day(23, 9)),
    run('run-10', 'WOR-008', 'claude', 'finished', day(12, 10), day(13, 9)),
    run('run-11', 'WOR-006', 'gemini', 'stopped', day(22, 9), day(22, 10)),
  ],
  approvals: [
    approval('comment-1', 'WOR-001', '__self__', day(3, 8)),
    approval('comment-3', 'WOR-002', '__self__', day(8, 9)),
    approval('comment-4', 'WOR-008', 'alice', day(13, 23)),
  ],
}

/** 2026-W01 through the last second of 2026-W04, which now (day 24) cuts short. */
export const METRICS_INPUT: BoardMetricsInput = { workspaceIds: [METRICS_WORKSPACE], from: day(0), to: day(28) - 1 }

/** Write a history into a store row by row, with its own ids and times, the way the board would have. */
export async function writeMetricsHistory(store: BoardStore, history: BoardMetricsHistory): Promise<void> {
  for (const row of history.statuses) {
    await store.statuses.create(row)
  }
  for (const row of history.milestones) {
    await store.milestones.create(row)
  }
  for (const row of history.cards) {
    await store.issues.create(row)
  }
  for (const entry of history.entries) {
    await store.fieldChanges.create({
      id: entry.changeId,
      issueId: entry.issueId,
      field: 'statusId',
      fromValue: entry.fromStatusId,
      toValue: entry.toStatusId,
      actorKind: entry.actorKind,
      actorId: entry.actorId,
      sourceChatSessionId: null,
      createdAt: entry.at,
    })
  }
  for (const row of history.runs) {
    await store.runs.create(row)
  }
  for (const row of history.approvals) {
    await store.comments.create(row)
  }
}

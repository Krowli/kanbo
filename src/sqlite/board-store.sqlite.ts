import { and, asc, desc, eq, getTableColumns, gte, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'

import type {
  BoardActiveRun,
  BoardCardPage,
  BoardCardQuery,
  BoardMilestoneCardCount,
  BoardRunProjection,
  BoardRunProjectionScope,
  BoardStore,
  BoardTransactionMode,
  IssueCommentStore,
  IssueContextRefStore,
  IssueFieldChangeStore,
  IssueMilestoneStore,
  IssuePullRequestStore,
  IssueRelationStore,
  IssueRowStore,
  IssueRunStore,
  IssueStatusStore,
  KanbanMetaStore,
} from '../board-store'
import { containsLikePattern } from '../domain/like-pattern'
import {
  issueComments,
  issueFieldChanges,
  issueMilestones,
  issuePullRequests,
  issueRelations,
  issueRuns,
  issues,
  issueStatuses,
  kanbanMeta,
} from './schema'
import type { SqliteDatabase } from './transaction'
import { runSqliteTransaction } from './transaction'

/**
 * One `BoardStore` group with the `Promise` taken off every method: better-sqlite3
 * is synchronous, so the core returns rows directly and the facade below is what
 * adds the promises back.
 */
type SyncStoreGroup<TGroup> = {
  [TMethod in keyof TGroup]: TGroup[TMethod] extends (...args: infer TArgs) => Promise<infer TResult>
    ? (...args: TArgs) => TResult
    : never
}

/**
 * The synchronous core of the SQLite store — the methods `BoardStore` declares,
 * resolved rather than promised.
 *
 * Every statement in the module runs through this core; the store returned by
 * `createSqliteBoardStore` is a thin async wrapper over it. Transactions are not
 * part of it: only the facade offers one, because only an awaitable transaction
 * can hold a `BoardStore` callback open.
 */
interface SqliteBoardStoreCore {
  statuses: SyncStoreGroup<IssueStatusStore>
  milestones: SyncStoreGroup<IssueMilestoneStore>
  issues: SyncStoreGroup<IssueRowStore>
  comments: SyncStoreGroup<IssueCommentStore>
  runs: SyncStoreGroup<IssueRunStore>
  relations: SyncStoreGroup<IssueRelationStore>
  contextRefs: SyncStoreGroup<IssueContextRefStore>
  fieldChanges: SyncStoreGroup<IssueFieldChangeStore>
  pullRequests: SyncStoreGroup<IssuePullRequestStore>
  meta: SyncStoreGroup<KanbanMetaStore>
}

/**
 * The order two runs of one card are in when they started in the same second.
 *
 * `started_at` counts whole seconds and a run id is a random UUID, so the column
 * pair the attempt number is built on cannot separate two launches a second
 * apart — the row the board wrote second has to be the second attempt. SQLite
 * hands that out already: `rowid` rises with every insert. A store on another
 * engine answers the same question with whatever its own insert order is.
 */
const RUN_INSERTION_ORDER = sql`${issueRuns}.rowid asc`

/**
 * The same tie-break for the two tables that record what happened to a card.
 *
 * `created_at` counts whole seconds here too, and a person approving a card and
 * an agent commenting on it inside the same second must come back in the order
 * the board wrote them: `readApproval` takes the *last* comment to decide
 * whether the card was approved or returned.
 */
const COMMENT_INSERTION_ORDER = sql`${issueComments}.rowid asc`
const FIELD_CHANGE_INSERTION_ORDER = sql`${issueFieldChanges}.rowid asc`

/** And for a card's pull-request links, which list in the order they were made. */
const PULL_REQUEST_INSERTION_ORDER = sql`${issuePullRequests}.rowid asc`

/**
 * The run facts of every card in scope, in one statement.
 *
 * The window functions do the grouping the caller would otherwise do with a
 * second query per card: `count(*)` counts the card's runs on every one of its
 * rows, and `row_number()` ranks them so that a `running` run wins, then the
 * newest start, then the row written last — the tie-break two runs started in
 * the same second need. Reading only rank 1 therefore leaves one row per card, carrying
 * the run the board should show — and `state` on that row says whether it is
 * still going, which is what turns it into an `activeRun` or into `null`.
 */
function selectRunProjection(database: SqliteDatabase, scope: BoardRunProjectionScope): BoardRunProjection[] {
  if ('issueIds' in scope && scope.issueIds.length === 0) {
    return []
  }

  const cards = 'workspaceId' in scope
    ? sql`select ${issues.id} from ${issues} where ${issues.workspaceId} = ${scope.workspaceId}`
    : sql`values ${sql.join(scope.issueIds.map(issueId => sql`(${issueId})`), sql`, `)}`

  const rows = database.all<{
    issueId: string
    attemptCount: number
    id: string
    agentId: string | null
    agentName: string
    state: BoardActiveRun['state']
    branch: string | null
    executionMode: BoardActiveRun['executionMode']
    chatSessionId: string | null
    startedAt: number
  }>(sql`
    select
      ranked.issue_id as issueId,
      ranked.attempt_count as attemptCount,
      ranked.id as id,
      ranked.agent_id as agentId,
      ranked.agent_name as agentName,
      ranked.state as state,
      ranked.branch as branch,
      ranked.execution_mode as executionMode,
      ranked.chat_session_id as chatSessionId,
      ranked.started_at as startedAt
    from (
      select
        run.*,
        count(*) over (partition by run.issue_id) as attempt_count,
        row_number() over (
          partition by run.issue_id
          order by (run.state = 'running') desc, run.started_at desc, run.rowid desc
        ) as card_rank
      from ${issueRuns} as run
      where run.issue_id in (${cards})
    ) as ranked
    where ranked.card_rank = 1
  `)

  return rows.map(row => ({
    issueId: row.issueId,
    attemptCount: row.attemptCount,
    activeRun: row.state === 'running'
      ? {
          id: row.id,
          agentId: row.agentId,
          agentName: row.agentName,
          state: row.state,
          branch: row.branch,
          executionMode: row.executionMode,
          chatSessionId: row.chatSessionId,
          startedAt: row.startedAt,
        }
      : null,
  }))
}

/**
 * One page of the cards a query picks, and how many it picks in all, in one
 * statement: `count(*) over ()` is taken over every picked row before `limit`
 * and `offset` cut the page out of them. Only a page past the last card — no
 * row to carry the count — asks a second time.
 */
function selectCardPage(database: SqliteDatabase, query: BoardCardQuery): BoardCardPage {
  if (query.statusIds?.length === 0 || query.priorities?.length === 0) {
    return { cards: [], total: 0 }
  }
  const where = and(...cardQueryPredicates(query))
  const rows = database
    .select({ ...getTableColumns(issues), pickedTotal: sql<number>`count(*) over ()` })
    .from(issues)
    .where(where)
    .orderBy(issues.order, desc(issues.createdAt), issues.id)
    // SQLite takes no offset without a limit; this one is no limit at all.
    .limit(query.limit ?? Number.MAX_SAFE_INTEGER)
    .offset(query.offset ?? 0)
    .all()
  if (rows.length === 0) {
    const total = (query.offset ?? 0) > 0
      ? database.select({ count: sql<number>`count(*)` }).from(issues).where(where).get()?.count ?? 0
      : 0
    return { cards: [], total }
  }
  return {
    cards: rows.map(({ pickedTotal: _total, ...card }) => card),
    total: rows[0]!.pickedTotal,
  }
}

function cardQueryPredicates(query: BoardCardQuery) {
  // One set of running cards for the whole statement, not a lookup per card.
  const running = sql`${issues.id} in (select ${issueRuns.issueId} from ${issueRuns} where ${issueRuns.state} = 'running')`
  const pattern = containsLikePattern(query.text ?? '')
  return [
    eq(issues.workspaceId, query.workspaceId),
    query.statusIds === undefined ? undefined : inArray(issues.statusId, [...query.statusIds]),
    query.waitingForPerson === undefined
      ? undefined
      : query.waitingForPerson ? eq(issues.waitingFor, 'human') : isNull(issues.waitingFor),
    query.parentIssueId === undefined ? undefined : eq(issues.parentIssueId, query.parentIssueId),
    query.hasActiveRun === undefined ? undefined : query.hasActiveRun ? running : sql`not ${running}`,
    query.text === undefined
      ? undefined
      : sql`(${issues.id} like ${pattern} escape '\\' or ${issues.title} like ${pattern} escape '\\' or coalesce(${issues.description}, '') like ${pattern} escape '\\')`,
    query.updatedSince === undefined ? undefined : gte(issues.updatedAt, query.updatedSince),
    ...(query.labels ?? []).map(label => sql`exists (select 1 from json_each(${issues.labels}) where value = ${label})`),
    query.priorities === undefined ? undefined : inArray(issues.priority, [...query.priorities]),
  ]
}

/**
 * Bind the store's statements to one SQLite handle. `resolveDatabase` is called
 * per statement rather than captured, so the store follows a host that swaps its
 * database out (a server that resets its infrastructure between tests, say).
 */
function createSqliteBoardStoreCore(resolveDatabase: () => SqliteDatabase): SqliteBoardStoreCore {
  return {
    statuses: {
      listByWorkspace: workspaceId => resolveDatabase()
        .select()
        .from(issueStatuses)
        .where(eq(issueStatuses.workspaceId, workspaceId))
        .orderBy(issueStatuses.order)
        .all(),
      listAllInBoardOrder: () => resolveDatabase()
        .select()
        .from(issueStatuses)
        .orderBy(issueStatuses.workspaceId, issueStatuses.order)
        .all(),
      listAll: () => resolveDatabase().select().from(issueStatuses).all(),
      findById: statusId => resolveDatabase()
        .select()
        .from(issueStatuses)
        .where(eq(issueStatuses.id, statusId))
        .get() ?? null,
      // A board write already holds the file's lock (`begin immediate`): nobody
      // else writes until it ends, so reading the row is locking it.
      lockById: statusId => resolveDatabase()
        .select()
        .from(issueStatuses)
        .where(eq(issueStatuses.id, statusId))
        .get() ?? null,
      findInWorkspace: (workspaceId, statusId) => resolveDatabase()
        .select()
        .from(issueStatuses)
        .where(sql`${issueStatuses.workspaceId} = ${workspaceId} AND ${issueStatuses.id} = ${statusId}`)
        .get() ?? null,
      countByWorkspace: (workspaceId) => {
        const row = resolveDatabase()
          .select({ count: sql<number>`count(*)` })
          .from(issueStatuses)
          .where(eq(issueStatuses.workspaceId, workspaceId))
          .get()
        return row?.count ?? 0
      },
      create: values => resolveDatabase().insert(issueStatuses).values(values).returning().get(),
      update: (statusId, patch) => {
        resolveDatabase().update(issueStatuses).set(patch).where(eq(issueStatuses.id, statusId)).run()
      },
      delete: (statusId) => {
        resolveDatabase().delete(issueStatuses).where(eq(issueStatuses.id, statusId)).run()
      },
    },

    milestones: {
      listNewestFirst: (workspaceId) => {
        const predicates = [
          workspaceId ? eq(issueMilestones.workspaceId, workspaceId) : undefined,
        ].filter(predicate => predicate !== undefined)
        return resolveDatabase()
          .select()
          .from(issueMilestones)
          .where(predicates.length > 0 ? and(...predicates) : undefined)
          .orderBy(desc(issueMilestones.createdAt))
          .all()
      },
      listByWorkspace: workspaceId => resolveDatabase()
        .select()
        .from(issueMilestones)
        .where(eq(issueMilestones.workspaceId, workspaceId))
        .all(),
      listAll: () => resolveDatabase().select().from(issueMilestones).all(),
      findById: milestoneId => resolveDatabase()
        .select()
        .from(issueMilestones)
        .where(eq(issueMilestones.id, milestoneId))
        .get() ?? null,
      findInWorkspace: (workspaceId, milestoneId) => resolveDatabase()
        .select()
        .from(issueMilestones)
        .where(and(eq(issueMilestones.id, milestoneId), eq(issueMilestones.workspaceId, workspaceId)))
        .get() ?? null,
      create: values => resolveDatabase().insert(issueMilestones).values(values).returning().get(),
      update: (milestoneId, patch) => {
        resolveDatabase().update(issueMilestones).set(patch).where(eq(issueMilestones.id, milestoneId)).run()
      },
      delete: (milestoneId) => {
        resolveDatabase().delete(issueMilestones).where(eq(issueMilestones.id, milestoneId)).run()
      },
    },

    issues: {
      listInBoardOrder: (workspaceId) => {
        const predicates = [
          workspaceId ? eq(issues.workspaceId, workspaceId) : undefined,
        ].filter(predicate => predicate !== undefined)
        return resolveDatabase()
          .select()
          .from(issues)
          .where(predicates.length > 0 ? and(...predicates) : undefined)
          // Board position is authoritative; creation time only breaks ties between
          // issues that have never been dragged (all of which share order 0), and the
          // id breaks what is left, so a page read never skips or repeats a card.
          .orderBy(issues.order, desc(issues.createdAt), issues.id)
          .all()
      },
      listNewestFirst: () => resolveDatabase().select().from(issues).orderBy(desc(issues.createdAt)).all(),
      listAll: () => resolveDatabase().select().from(issues).all(),
      listByWorkspace: workspaceId => resolveDatabase()
        .select()
        .from(issues)
        .where(eq(issues.workspaceId, workspaceId))
        .all(),
      listPage: query => selectCardPage(resolveDatabase(), query),
      countByMilestone: (workspaceId): BoardMilestoneCardCount[] => resolveDatabase()
        .select({ milestoneId: sql<string>`${issues.milestoneId}`, statusId: issues.statusId, count: sql<number>`count(*)` })
        .from(issues)
        .where(and(eq(issues.workspaceId, workspaceId), isNotNull(issues.milestoneId)))
        .groupBy(issues.milestoneId, issues.statusId)
        .all(),
      listByIds: issueIds => resolveDatabase().select().from(issues).where(inArray(issues.id, issueIds)).all(),
      findById: issueId => resolveDatabase().select().from(issues).where(eq(issues.id, issueId)).get() ?? null,
      findInWorkspace: (workspaceId, issueId) => resolveDatabase()
        .select()
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.workspaceId, workspaceId)))
        .get() ?? null,
      findByNumber: (workspaceId, number) => resolveDatabase()
        .select()
        .from(issues)
        .where(and(eq(issues.workspaceId, workspaceId), eq(issues.number, number)))
        .get() ?? null,
      maxNumber: (workspaceId) => {
        const row = resolveDatabase()
          .select({ maxNum: sql<number>`coalesce(max(${issues.number}), 0)` })
          .from(issues)
          .where(eq(issues.workspaceId, workspaceId))
          .get()
        return row?.maxNum ?? 0
      },
      maxOrder: (workspaceId) => {
        const row = resolveDatabase()
          .select({ maxOrder: sql<number>`coalesce(max(${issues.order}), 0)` })
          .from(issues)
          .where(eq(issues.workspaceId, workspaceId))
          .get()
        return row?.maxOrder ?? 0
      },
      create: values => resolveDatabase().insert(issues).values(values).returning().get(),
      update: (issueId, patch) => {
        resolveDatabase().update(issues).set(patch).where(eq(issues.id, issueId)).run()
      },
      updateMany: (issueIds, patch) => resolveDatabase()
        .update(issues)
        .set(patch)
        .where(sql`${issues.id} IN (${sql.join(issueIds.map(issueId => sql`${issueId}`), sql`, `)})`)
        .run()
        .changes,
      clearMilestoneReferences: (milestoneId, updatedAt) => {
        resolveDatabase()
          .update(issues)
          .set({ milestoneId: null, updatedAt })
          .where(eq(issues.milestoneId, milestoneId))
          .run()
      },
      clearParentReferences: (parentIssueId, updatedAt) => {
        resolveDatabase()
          .update(issues)
          .set({ parentIssueId: null, updatedAt })
          .where(eq(issues.parentIssueId, parentIssueId))
          .run()
      },
      clearDelegateReferences: (delegate, updatedAt) => resolveDatabase()
        .update(issues)
        .set({ delegateAgentId: null, delegateProviderTargetId: null, updatedAt })
        .where('agentId' in delegate
          ? eq(issues.delegateAgentId, delegate.agentId)
          : eq(issues.delegateProviderTargetId, delegate.providerTargetId))
        .run()
        .changes,
      delete: (issueId) => {
        resolveDatabase().delete(issues).where(eq(issues.id, issueId)).run()
      },
    },

    comments: {
      listByIssue: issueId => resolveDatabase()
        .select()
        .from(issueComments)
        .where(eq(issueComments.issueId, issueId))
        .orderBy(asc(issueComments.createdAt), COMMENT_INSERTION_ORDER)
        .all(),
      findById: commentId => resolveDatabase()
        .select()
        .from(issueComments)
        .where(eq(issueComments.id, commentId))
        .get() ?? null,
      findByDedupeKey: (issueId, dedupeKey) => resolveDatabase()
        .select()
        .from(issueComments)
        .where(and(eq(issueComments.issueId, issueId), eq(issueComments.dedupeKey, dedupeKey)))
        .get() ?? null,
      // `substr` rather than `like`: a key may carry `_` or `%`, which `like`
      // would read as wildcards.
      listByDedupeKeyPrefix: (issueId, prefix) => resolveDatabase()
        .select()
        .from(issueComments)
        .where(and(
          eq(issueComments.issueId, issueId),
          sql`substr(${issueComments.dedupeKey}, 1, ${prefix.length}) = ${prefix}`,
        ))
        .orderBy(asc(issueComments.createdAt), COMMENT_INSERTION_ORDER)
        .all(),
      create: values => resolveDatabase().insert(issueComments).values(values).returning().get(),
      createOnce: (values) => {
        const database = resolveDatabase()
        // `do nothing` returns no row when the key is already taken, and the
        // read below then finds whichever row holds it.
        const inserted = database.insert(issueComments).values(values).onConflictDoNothing().returning().get()
        if (inserted) {
          return inserted
        }
        const existing = database
          .select()
          .from(issueComments)
          .where(and(eq(issueComments.issueId, values.issueId), eq(issueComments.dedupeKey, values.dedupeKey)))
          .get()
        if (!existing) {
          // The insert was refused, and not by the dedupe index: some other
          // constraint on the row said no. Returning nothing here would hand the
          // caller an `IssueComment` that does not exist.
          throw new Error(
            `issue comment for ${values.issueId} was refused, and no comment carries dedupe key ${values.dedupeKey}`,
          )
        }
        return existing
      },
      delete: (commentId) => {
        resolveDatabase().delete(issueComments).where(eq(issueComments.id, commentId)).run()
      },
    },

    runs: {
      listByIssue: issueId => resolveDatabase()
        .select()
        .from(issueRuns)
        .where(eq(issueRuns.issueId, issueId))
        .orderBy(asc(issueRuns.startedAt), RUN_INSERTION_ORDER)
        .all(),
      listRunning: issueId => resolveDatabase()
        .select()
        .from(issueRuns)
        .where(and(eq(issueRuns.issueId, issueId), eq(issueRuns.state, 'running')))
        .orderBy(asc(issueRuns.startedAt), RUN_INSERTION_ORDER)
        .all(),
      listRunningWithSession: () => resolveDatabase()
        .select()
        .from(issueRuns)
        .where(and(eq(issueRuns.state, 'running'), isNotNull(issueRuns.chatSessionId)))
        .orderBy(asc(issueRuns.startedAt), RUN_INSERTION_ORDER)
        .all(),
      findById: runId => resolveDatabase().select().from(issueRuns).where(eq(issueRuns.id, runId)).get() ?? null,
      findByChatSessionId: chatSessionId => resolveDatabase()
        .select()
        .from(issueRuns)
        .where(eq(issueRuns.chatSessionId, chatSessionId))
        .orderBy(desc(issueRuns.startedAt), sql`${issueRuns}.rowid desc`)
        .get() ?? null,
      countByIssue: (issueId) => {
        const row = resolveDatabase()
          .select({ count: sql<number>`count(*)` })
          .from(issueRuns)
          .where(eq(issueRuns.issueId, issueId))
          .get()
        return row?.count ?? 0
      },
      create: values => resolveDatabase().insert(issueRuns).values(values).returning().get(),
      update: (runId, patch) => {
        resolveDatabase().update(issueRuns).set(patch).where(eq(issueRuns.id, runId)).run()
      },
      project: scope => selectRunProjection(resolveDatabase(), scope),
    },

    relations: {
      listByIssue: issueId => resolveDatabase()
        .select()
        .from(issueRelations)
        .where(or(eq(issueRelations.sourceIssueId, issueId), eq(issueRelations.targetIssueId, issueId)))
        .all(),
      findById: relationId => resolveDatabase()
        .select()
        .from(issueRelations)
        .where(eq(issueRelations.id, relationId))
        .get() ?? null,
      findMatching: edge => resolveDatabase()
        .select()
        .from(issueRelations)
        .where(and(
          eq(issueRelations.type, edge.type),
          edge.type === 'relates_to'
            ? or(
                and(
                  eq(issueRelations.sourceIssueId, edge.sourceIssueId),
                  eq(issueRelations.targetIssueId, edge.targetIssueId),
                ),
                and(
                  eq(issueRelations.sourceIssueId, edge.targetIssueId),
                  eq(issueRelations.targetIssueId, edge.sourceIssueId),
                ),
              )
            : and(
                eq(issueRelations.sourceIssueId, edge.sourceIssueId),
                eq(issueRelations.targetIssueId, edge.targetIssueId),
              ),
        ))
        .get() ?? null,
      create: values => resolveDatabase().insert(issueRelations).values(values).returning().get(),
      delete: (relationId) => {
        resolveDatabase().delete(issueRelations).where(eq(issueRelations.id, relationId)).run()
      },
      deleteByIssue: (issueId) => {
        resolveDatabase()
          .delete(issueRelations)
          .where(or(eq(issueRelations.sourceIssueId, issueId), eq(issueRelations.targetIssueId, issueId)))
          .run()
      },
    },

    contextRefs: {
      replace: (issueId, contextRefs, updatedAt) => {
        resolveDatabase().update(issues).set({ contextRefs, updatedAt }).where(eq(issues.id, issueId)).run()
      },
    },

    fieldChanges: {
      listByIssue: issueId => resolveDatabase()
        .select()
        .from(issueFieldChanges)
        .where(eq(issueFieldChanges.issueId, issueId))
        .orderBy(asc(issueFieldChanges.createdAt), FIELD_CHANGE_INSERTION_ORDER)
        .all(),
      listByIssueField: (issueId, field) => resolveDatabase()
        .select()
        .from(issueFieldChanges)
        .where(and(eq(issueFieldChanges.issueId, issueId), eq(issueFieldChanges.field, field)))
        .orderBy(asc(issueFieldChanges.createdAt), FIELD_CHANGE_INSERTION_ORDER)
        .all(),
      create: (values) => {
        resolveDatabase().insert(issueFieldChanges).values(values).run()
      },
    },

    pullRequests: {
      listByIssue: issueId => resolveDatabase()
        .select()
        .from(issuePullRequests)
        .where(eq(issuePullRequests.issueId, issueId))
        .orderBy(asc(issuePullRequests.createdAt), PULL_REQUEST_INSERTION_ORDER)
        .all(),
      listLinked: () => resolveDatabase()
        .select({ ...getTableColumns(issuePullRequests), workspaceId: issues.workspaceId })
        .from(issuePullRequests)
        .innerJoin(issues, eq(issues.id, issuePullRequests.issueId))
        .orderBy(asc(issuePullRequests.createdAt), PULL_REQUEST_INSERTION_ORDER)
        .all(),
      link: (values) => {
        const database = resolveDatabase()
        // `do nothing` returns no row when the card already names the pull
        // request, and the read below then finds the link that does.
        const inserted = database.insert(issuePullRequests).values(values).onConflictDoNothing().returning().get()
        if (inserted) {
          return inserted
        }
        const existing = database
          .select()
          .from(issuePullRequests)
          .where(and(
            eq(issuePullRequests.issueId, values.issueId),
            eq(issuePullRequests.owner, values.owner),
            eq(issuePullRequests.repo, values.repo),
            eq(issuePullRequests.number, values.number),
          ))
          .get()
        if (!existing) {
          // Refused, and not by the one index that makes a link idempotent.
          throw new Error(
            `pull request link for ${values.issueId} was refused, and the card names no ${values.owner}/${values.repo}#${values.number}`,
          )
        }
        return existing
      },
      unlink: (issueId, linkId) => resolveDatabase()
        .delete(issuePullRequests)
        .where(and(eq(issuePullRequests.id, linkId), eq(issuePullRequests.issueId, issueId)))
        .returning()
        .get() ?? null,
    },

    meta: {
      read: key => resolveDatabase().select().from(kanbanMeta).where(eq(kanbanMeta.key, key)).get() ?? null,
      bumpRevision: (key, updatedAt) => {
        resolveDatabase()
          .insert(kanbanMeta)
          .values({ key, revision: 1, updatedAt })
          .onConflictDoUpdate({
            target: kanbanMeta.key,
            set: { revision: sql`${kanbanMeta.revision} + 1`, updatedAt },
          })
          .run()
      },
    },
  }
}

/**
 * `BoardStore` backed by SQLite: every method resolves immediately, because the
 * core underneath it is synchronous.
 *
 * `database` is a function rather than a handle so the store follows whatever
 * the host currently has open — a server passes its single connection
 * accessor, a standalone reader passes its own.
 */
export function createSqliteBoardStore(options: { database: () => SqliteDatabase }): BoardStore {
  const core = createSqliteBoardStoreCore(options.database)

  const store: BoardStore = {
    statuses: {
      listByWorkspace: async workspaceId => core.statuses.listByWorkspace(workspaceId),
      listAllInBoardOrder: async () => core.statuses.listAllInBoardOrder(),
      listAll: async () => core.statuses.listAll(),
      findById: async statusId => core.statuses.findById(statusId),
      lockById: async statusId => core.statuses.lockById(statusId),
      findInWorkspace: async (workspaceId, statusId) => core.statuses.findInWorkspace(workspaceId, statusId),
      countByWorkspace: async workspaceId => core.statuses.countByWorkspace(workspaceId),
      create: async values => core.statuses.create(values),
      update: async (statusId, patch) => core.statuses.update(statusId, patch),
      delete: async statusId => core.statuses.delete(statusId),
    },

    milestones: {
      listNewestFirst: async workspaceId => core.milestones.listNewestFirst(workspaceId),
      listByWorkspace: async workspaceId => core.milestones.listByWorkspace(workspaceId),
      listAll: async () => core.milestones.listAll(),
      findById: async milestoneId => core.milestones.findById(milestoneId),
      findInWorkspace: async (workspaceId, milestoneId) => core.milestones.findInWorkspace(workspaceId, milestoneId),
      create: async values => core.milestones.create(values),
      update: async (milestoneId, patch) => core.milestones.update(milestoneId, patch),
      delete: async milestoneId => core.milestones.delete(milestoneId),
    },

    issues: {
      listInBoardOrder: async workspaceId => core.issues.listInBoardOrder(workspaceId),
      listNewestFirst: async () => core.issues.listNewestFirst(),
      listAll: async () => core.issues.listAll(),
      listByWorkspace: async workspaceId => core.issues.listByWorkspace(workspaceId),
      listPage: async query => core.issues.listPage(query),
      countByMilestone: async workspaceId => core.issues.countByMilestone(workspaceId),
      listByIds: async issueIds => core.issues.listByIds(issueIds),
      findById: async issueId => core.issues.findById(issueId),
      findInWorkspace: async (workspaceId, issueId) => core.issues.findInWorkspace(workspaceId, issueId),
      findByNumber: async (workspaceId, number) => core.issues.findByNumber(workspaceId, number),
      maxNumber: async workspaceId => core.issues.maxNumber(workspaceId),
      maxOrder: async workspaceId => core.issues.maxOrder(workspaceId),
      create: async values => core.issues.create(values),
      update: async (issueId, patch) => core.issues.update(issueId, patch),
      updateMany: async (issueIds, patch) => core.issues.updateMany(issueIds, patch),
      clearMilestoneReferences: async (milestoneId, updatedAt) => core.issues.clearMilestoneReferences(milestoneId, updatedAt),
      clearParentReferences: async (parentIssueId, updatedAt) => core.issues.clearParentReferences(parentIssueId, updatedAt),
      clearDelegateReferences: async (delegate, updatedAt) => core.issues.clearDelegateReferences(delegate, updatedAt),
      delete: async issueId => core.issues.delete(issueId),
    },

    comments: {
      listByIssue: async issueId => core.comments.listByIssue(issueId),
      findById: async commentId => core.comments.findById(commentId),
      findByDedupeKey: async (issueId, dedupeKey) => core.comments.findByDedupeKey(issueId, dedupeKey),
      listByDedupeKeyPrefix: async (issueId, prefix) => core.comments.listByDedupeKeyPrefix(issueId, prefix),
      create: async values => core.comments.create(values),
      createOnce: async values => core.comments.createOnce(values),
      delete: async commentId => core.comments.delete(commentId),
    },

    runs: {
      listByIssue: async issueId => core.runs.listByIssue(issueId),
      listRunning: async issueId => core.runs.listRunning(issueId),
      listRunningWithSession: async () => core.runs.listRunningWithSession(),
      findById: async runId => core.runs.findById(runId),
      findByChatSessionId: async chatSessionId => core.runs.findByChatSessionId(chatSessionId),
      countByIssue: async issueId => core.runs.countByIssue(issueId),
      create: async values => core.runs.create(values),
      update: async (runId, patch) => core.runs.update(runId, patch),
      project: async scope => core.runs.project(scope),
    },

    relations: {
      listByIssue: async issueId => core.relations.listByIssue(issueId),
      findById: async relationId => core.relations.findById(relationId),
      findMatching: async edge => core.relations.findMatching(edge),
      create: async values => core.relations.create(values),
      delete: async relationId => core.relations.delete(relationId),
      deleteByIssue: async issueId => core.relations.deleteByIssue(issueId),
    },

    contextRefs: {
      replace: async (issueId, contextRefs, updatedAt) => core.contextRefs.replace(issueId, contextRefs, updatedAt),
    },

    fieldChanges: {
      listByIssue: async issueId => core.fieldChanges.listByIssue(issueId),
      listByIssueField: async (issueId, field) => core.fieldChanges.listByIssueField(issueId, field),
      create: async values => core.fieldChanges.create(values),
    },

    pullRequests: {
      listByIssue: async issueId => core.pullRequests.listByIssue(issueId),
      listLinked: async () => core.pullRequests.listLinked(),
      link: async values => core.pullRequests.link(values),
      unlink: async (issueId, linkId) => core.pullRequests.unlink(issueId, linkId),
    },

    meta: {
      read: async key => core.meta.read(key),
      bumpRevision: async (key, updatedAt) => core.meta.bumpRevision(key, updatedAt),
    },

    /**
     * Run `fn` inside one SQLite transaction, through the driver-level helper in
     * `./transaction.ts`.
     *
     * The caller rule lives there in full; in short: `fn` must be the only
     * database-touching async chain in flight, and inside it only await
     * operations that resolve without I/O — store methods, synchronous database
     * writes.
     */
    transaction: async <T>(fn: (tx: BoardStore) => Promise<T>, transactionOptions?: { mode?: BoardTransactionMode }): Promise<T> => {
      // One connection backs the whole store, so it is already the transactional view.
      return await runSqliteTransaction(options.database(), () => fn(store), transactionOptions)
    },
  }

  return store
}

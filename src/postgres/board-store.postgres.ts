import type { SQL } from 'drizzle-orm'
import { and, asc, desc, eq, getTableColumns, gte, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'

import type {
  BoardCardPage,
  BoardCardQuery,
  BoardLinkedPullRequest,
  BoardMilestoneCardCount,
  BoardRunProjection,
  BoardRunProjectionScope,
  BoardStore,
  BoardTransactionMode,
} from '../board-store'
import { containsLikePattern } from '../domain/like-pattern'
import type { IssueComment, IssueFieldChange, IssuePullRequest, IssueRun } from '../sqlite/schema'
import type { BoardPostgresDatabase } from './open-database'
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

/** A run as Postgres keeps it: the board's run, plus the insertion order the board orders by. */
type StoredRun = typeof issueRuns.$inferSelect

/** A comment as Postgres keeps it, and a field change: the same, plus `seq`. */
type StoredComment = typeof issueComments.$inferSelect
type StoredFieldChange = typeof issueFieldChanges.$inferSelect
type StoredPullRequest = typeof issuePullRequests.$inferSelect

/**
 * The run without `seq`.
 *
 * `seq` is this dialect's answer to SQLite's `rowid` — the board's own record of
 * which of two runs started in the same second was written first. It is a fact
 * about the storage rather than about the run, so it is taken off here instead
 * of leaking into a type shared with a board that has no such column.
 */
function toIssueRun({ seq: _seq, ...run }: StoredRun): IssueRun {
  return run
}

/** The comment without `seq`, for the same reason a run is handed over without it. */
function toIssueComment({ seq: _seq, ...comment }: StoredComment): IssueComment {
  return comment
}

/** The field change without `seq`, for the same reason. */
function toIssueFieldChange({ seq: _seq, ...change }: StoredFieldChange): IssueFieldChange {
  return change
}

/** The pull-request link without `seq`, for the same reason. */
function toIssuePullRequest({ seq: _seq, ...link }: StoredPullRequest): IssuePullRequest {
  return link
}

/** A link with its card's workspace, without `seq`. */
function toLinkedPullRequest({ seq: _seq, ...link }: StoredPullRequest & { workspaceId: string }): BoardLinkedPullRequest {
  return link
}

/**
 * The run facts of every card in scope, in one statement.
 *
 * The same shape as the SQLite store's: `count(*)` counts the card's runs on
 * every one of its rows and `row_number()` ranks them — a `running` run first,
 * then the newest start, then the row written last — so reading only rank 1
 * leaves one row per card. Two differences from the file, both dialect: the
 * tie-break reads `seq` where SQLite reads `rowid`, and both window counters are
 * cast to `int` because Postgres counts in `bigint`, which a driver is free to
 * hand back as a string.
 */
async function selectRunProjection(
  database: BoardPostgresDatabase,
  scope: BoardRunProjectionScope,
): Promise<BoardRunProjection[]> {
  if ('issueIds' in scope && scope.issueIds.length === 0) {
    return []
  }

  const cards = 'workspaceId' in scope
    ? inArray(
        issueRuns.issueId,
        database.select({ id: issues.id }).from(issues).where(eq(issues.workspaceId, scope.workspaceId)),
      )
    : inArray(issueRuns.issueId, scope.issueIds)

  const ranked = database
    .select({
      issueId: issueRuns.issueId,
      attemptCount: sql<number>`cast(count(*) over (partition by ${issueRuns.issueId}) as int)`.as('attempt_count'),
      id: issueRuns.id,
      agentId: issueRuns.agentId,
      agentName: issueRuns.agentName,
      state: issueRuns.state,
      branch: issueRuns.branch,
      executionMode: issueRuns.executionMode,
      chatSessionId: issueRuns.chatSessionId,
      startedAt: issueRuns.startedAt,
      cardRank: sql<number>`cast(row_number() over (partition by ${issueRuns.issueId} order by (${issueRuns.state} = 'running') desc, ${issueRuns.startedAt} desc, ${issueRuns.seq} desc) as int)`.as('card_rank'),
    })
    .from(issueRuns)
    .where(cards)
    .as('ranked')

  const rows = await database
    .select({
      issueId: ranked.issueId,
      attemptCount: ranked.attemptCount,
      id: ranked.id,
      agentId: ranked.agentId,
      agentName: ranked.agentName,
      state: ranked.state,
      branch: ranked.branch,
      executionMode: ranked.executionMode,
      chatSessionId: ranked.chatSessionId,
      startedAt: ranked.startedAt,
    })
    .from(ranked)
    .where(eq(ranked.cardRank, 1))

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
 * statement — the SQLite store's read, with the count cast to `int` (Postgres
 * counts in `bigint`) and text matched with `ilike`, which folds every letter.
 */
async function selectCardPage(database: BoardPostgresDatabase, query: BoardCardQuery): Promise<BoardCardPage> {
  if (query.statusIds?.length === 0 || query.priorities?.length === 0) {
    return { cards: [], total: 0 }
  }
  const where = and(...cardQueryPredicates(query))
  const page = database
    .select({ ...getTableColumns(issues), pickedTotal: sql<number>`cast(count(*) over () as int)` })
    .from(issues)
    .where(where)
    .orderBy(issues.order, desc(issues.createdAt), issues.id)
    .offset(query.offset ?? 0)
    .$dynamic()
  const rows = await (query.limit === undefined ? page : page.limit(query.limit))
  if (rows.length === 0) {
    if ((query.offset ?? 0) === 0) {
      return { cards: [], total: 0 }
    }
    const [row] = await database.select({ count: sql<number>`cast(count(*) as int)` }).from(issues).where(where)
    return { cards: [], total: row?.count ?? 0 }
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
    query.returned === undefined ? undefined : query.returned ? returnedCard(running) : sql`not ${returnedCard(running)}`,
    query.text === undefined
      ? undefined
      : sql`(${issues.id} ilike ${pattern} escape '\\' or ${issues.title} ilike ${pattern} escape '\\' or coalesce(${issues.description}, '') ilike ${pattern} escape '\\')`,
    query.updatedSince === undefined ? undefined : gte(issues.updatedAt, query.updatedSince),
    ...(query.labels ?? []).map(label => sql`cast(${issues.labels} as jsonb) @> cast(${JSON.stringify([label])} as jsonb)`),
    query.priorities === undefined ? undefined : inArray(issues.priority, [...query.priorities]),
  ]
}

/**
 * A card a person sent back that nobody picked up again (`BoardCardQuery.returned`):
 * not waiting, not running, and its last decision a return — `seq` breaking a
 * tie inside one second where SQLite reads `rowid`.
 */
function returnedCard(running: SQL) {
  return sql`(${issues.waitingFor} is null and not ${running} and exists (
    select 1 from ${issueComments} as decision
    where decision.issue_id = ${issues.id} and decision.author_kind = 'system.returned'
      and not exists (
        select 1 from ${issueComments} as later
        where later.issue_id = decision.issue_id
          and later.author_kind in ('system.approved', 'system.returned')
          and (later.created_at > decision.created_at or (later.created_at = decision.created_at and later.seq > decision.seq))
      )
  ))`
}

/**
 * The board's statements against one Postgres handle — a connection, or a
 * transaction on one.
 *
 * `transaction` builds a second store over the transactional handle drizzle
 * hands it, which is the one structural difference from the SQLite store: there
 * a single connection *is* the transaction, so the store hands back itself.
 */
function createStoreOver(database: BoardPostgresDatabase): BoardStore {
  const store: BoardStore = {
    statuses: {
      listByWorkspace: async workspaceId => await database
        .select()
        .from(issueStatuses)
        .where(eq(issueStatuses.workspaceId, workspaceId))
        .orderBy(issueStatuses.order),
      listAllInBoardOrder: async () => await database
        .select()
        .from(issueStatuses)
        .orderBy(issueStatuses.workspaceId, issueStatuses.order),
      listAll: async () => await database.select().from(issueStatuses),
      findById: async (statusId) => {
        const [row] = await database.select().from(issueStatuses).where(eq(issueStatuses.id, statusId)).limit(1)
        return row ?? null
      },
      lockById: async (statusId) => {
        const [row] = await database.select().from(issueStatuses).where(eq(issueStatuses.id, statusId)).limit(1).for('update')
        return row ?? null
      },
      findInWorkspace: async (workspaceId, statusId) => {
        const [row] = await database
          .select()
          .from(issueStatuses)
          .where(and(eq(issueStatuses.workspaceId, workspaceId), eq(issueStatuses.id, statusId)))
          .limit(1)
        return row ?? null
      },
      countByWorkspace: async (workspaceId) => {
        const [row] = await database
          .select({ count: sql<number>`cast(count(*) as int)` })
          .from(issueStatuses)
          .where(eq(issueStatuses.workspaceId, workspaceId))
        return row?.count ?? 0
      },
      create: async (values) => {
        const [row] = await database.insert(issueStatuses).values(values).returning()
        return row
      },
      update: async (statusId, patch) => {
        await database.update(issueStatuses).set(patch).where(eq(issueStatuses.id, statusId))
      },
      delete: async (statusId) => {
        await database.delete(issueStatuses).where(eq(issueStatuses.id, statusId))
      },
    },

    milestones: {
      listNewestFirst: async workspaceId => await database
        .select()
        .from(issueMilestones)
        .where(workspaceId ? eq(issueMilestones.workspaceId, workspaceId) : undefined)
        .orderBy(desc(issueMilestones.createdAt)),
      listByWorkspace: async workspaceId => await database
        .select()
        .from(issueMilestones)
        .where(eq(issueMilestones.workspaceId, workspaceId)),
      listAll: async () => await database.select().from(issueMilestones),
      findById: async (milestoneId) => {
        const [row] = await database.select().from(issueMilestones).where(eq(issueMilestones.id, milestoneId)).limit(1)
        return row ?? null
      },
      findInWorkspace: async (workspaceId, milestoneId) => {
        const [row] = await database
          .select()
          .from(issueMilestones)
          .where(and(eq(issueMilestones.id, milestoneId), eq(issueMilestones.workspaceId, workspaceId)))
          .limit(1)
        return row ?? null
      },
      create: async (values) => {
        const [row] = await database.insert(issueMilestones).values(values).returning()
        return row
      },
      update: async (milestoneId, patch) => {
        await database.update(issueMilestones).set(patch).where(eq(issueMilestones.id, milestoneId))
      },
      delete: async (milestoneId) => {
        await database.delete(issueMilestones).where(eq(issueMilestones.id, milestoneId))
      },
    },

    issues: {
      listInBoardOrder: async workspaceId => await database
        .select()
        .from(issues)
        .where(workspaceId ? eq(issues.workspaceId, workspaceId) : undefined)
        // Board position is authoritative; creation time only breaks ties between
        // issues that have never been dragged (all of which share order 0), and the
        // id breaks what is left, so a page read never skips or repeats a card.
        .orderBy(issues.order, desc(issues.createdAt), issues.id),
      listNewestFirst: async () => await database.select().from(issues).orderBy(desc(issues.createdAt)),
      listAll: async () => await database.select().from(issues),
      listByWorkspace: async workspaceId => await database
        .select()
        .from(issues)
        .where(eq(issues.workspaceId, workspaceId)),
      listPage: async query => await selectCardPage(database, query),
      countByMilestone: async (workspaceId): Promise<BoardMilestoneCardCount[]> => await database
        .select({ milestoneId: sql<string>`${issues.milestoneId}`, statusId: issues.statusId, count: sql<number>`cast(count(*) as int)` })
        .from(issues)
        .where(and(eq(issues.workspaceId, workspaceId), isNotNull(issues.milestoneId)))
        .groupBy(issues.milestoneId, issues.statusId),
      listByIds: async issueIds => await database.select().from(issues).where(inArray(issues.id, issueIds)),
      findById: async (issueId) => {
        const [row] = await database.select().from(issues).where(eq(issues.id, issueId)).limit(1)
        return row ?? null
      },
      findInWorkspace: async (workspaceId, issueId) => {
        const [row] = await database
          .select()
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.workspaceId, workspaceId)))
          .limit(1)
        return row ?? null
      },
      findByNumber: async (workspaceId, number) => {
        const [row] = await database
          .select()
          .from(issues)
          .where(and(eq(issues.workspaceId, workspaceId), eq(issues.number, number)))
          .limit(1)
        return row ?? null
      },
      maxNumber: async (workspaceId) => {
        const [row] = await database
          .select({ maxNumber: sql<number>`cast(coalesce(max(${issues.number}), 0) as int)` })
          .from(issues)
          .where(eq(issues.workspaceId, workspaceId))
        return row?.maxNumber ?? 0
      },
      maxOrder: async (workspaceId) => {
        const [row] = await database
          .select({ maxOrder: sql<number>`cast(coalesce(max(${issues.order}), 0) as int)` })
          .from(issues)
          .where(eq(issues.workspaceId, workspaceId))
        return row?.maxOrder ?? 0
      },
      /**
       * The one insert the board expects to be refused sometimes.
       *
       * Two writers can pick the same card number, and the unique index turns
       * the loser's insert into an error that the numbering answers by reading
       * the board again. Postgres refuses to read anything from a transaction a
       * statement has failed in, so this insert runs inside a savepoint of its
       * own: when it is refused, the savepoint rolls back and the caller's
       * transaction is still there to be read. A board in a file needs nothing
       * of the sort — SQLite leaves a transaction usable after a failed
       * statement — which is why this lives in the store and not in `ops`.
       */
      create: async (values) => {
        const [row] = await database.transaction(async tx => await tx.insert(issues).values(values).returning())
        return row
      },
      update: async (issueId, patch) => {
        await database.update(issues).set(patch).where(eq(issues.id, issueId))
      },
      updateMany: async (issueIds, patch) => {
        if (issueIds.length === 0) {
          return 0
        }
        // The rows written are counted by naming them back: `returning` is the
        // one row count every Postgres driver reports the same way.
        const written = await database
          .update(issues)
          .set(patch)
          .where(inArray(issues.id, issueIds))
          .returning({ id: issues.id })
        return written.length
      },
      clearMilestoneReferences: async (milestoneId, updatedAt) => {
        await database
          .update(issues)
          .set({ milestoneId: null, updatedAt })
          .where(eq(issues.milestoneId, milestoneId))
      },
      clearParentReferences: async (parentIssueId, updatedAt) => {
        await database
          .update(issues)
          .set({ parentIssueId: null, updatedAt })
          .where(eq(issues.parentIssueId, parentIssueId))
      },
      clearDelegateReferences: async (delegate, updatedAt) => {
        const written = await database
          .update(issues)
          .set({ delegateAgentId: null, delegateProviderTargetId: null, updatedAt })
          .where('agentId' in delegate
            ? eq(issues.delegateAgentId, delegate.agentId)
            : eq(issues.delegateProviderTargetId, delegate.providerTargetId))
          .returning({ id: issues.id })
        return written.length
      },
      delete: async (issueId) => {
        await database.delete(issues).where(eq(issues.id, issueId))
      },
    },

    comments: {
      listByIssue: async issueId => (await database
        .select()
        .from(issueComments)
        .where(eq(issueComments.issueId, issueId))
        .orderBy(asc(issueComments.createdAt), asc(issueComments.seq))).map(toIssueComment),
      listLatestByIssues: async (issueIds, authorKinds) => {
        if (issueIds.length === 0 || authorKinds?.length === 0) {
          return []
        }
        const ranked = database
          .select({
            id: issueComments.id,
            commentRank: sql<number>`cast(row_number() over (partition by ${issueComments.issueId} order by ${issueComments.createdAt} desc, ${issueComments.seq} desc) as int)`.as('comment_rank'),
          })
          .from(issueComments)
          .where(and(
            inArray(issueComments.issueId, [...issueIds]),
            authorKinds === undefined ? undefined : inArray(issueComments.authorKind, [...authorKinds]),
          ))
          .as('ranked')
        return (await database
          .select(getTableColumns(issueComments))
          .from(issueComments)
          .innerJoin(ranked, eq(ranked.id, issueComments.id))
          .where(eq(ranked.commentRank, 1))).map(toIssueComment)
      },
      findById: async (commentId) => {
        const [row] = await database.select().from(issueComments).where(eq(issueComments.id, commentId)).limit(1)
        return row ? toIssueComment(row) : null
      },
      findByDedupeKey: async (issueId, dedupeKey) => {
        const [row] = await database
          .select()
          .from(issueComments)
          .where(and(eq(issueComments.issueId, issueId), eq(issueComments.dedupeKey, dedupeKey)))
          .limit(1)
        return row ? toIssueComment(row) : null
      },
      // `starts_with` rather than `like`: a key may carry `_` or `%`, which
      // `like` would read as wildcards.
      listByDedupeKeyPrefix: async (issueId, prefix) => (await database
        .select()
        .from(issueComments)
        .where(and(eq(issueComments.issueId, issueId), sql`starts_with(${issueComments.dedupeKey}, ${prefix})`))
        .orderBy(asc(issueComments.createdAt), asc(issueComments.seq))).map(toIssueComment),
      create: async (values) => {
        const [row] = await database.insert(issueComments).values(values).returning()
        return toIssueComment(row)
      },
      createOnce: async (values) => {
        // `do nothing` returns no row when the key is already taken, and the
        // read below then finds whichever row holds it.
        const [inserted] = await database.insert(issueComments).values(values).onConflictDoNothing().returning()
        if (inserted) {
          return toIssueComment(inserted)
        }
        const [existing] = await database
          .select()
          .from(issueComments)
          .where(and(eq(issueComments.issueId, values.issueId), eq(issueComments.dedupeKey, values.dedupeKey)))
          .limit(1)
        if (!existing) {
          // The insert was refused, and not by the dedupe index: some other
          // constraint on the row said no. Returning nothing here would hand the
          // caller an `IssueComment` that does not exist.
          throw new Error(
            `issue comment for ${values.issueId} was refused, and no comment carries dedupe key ${values.dedupeKey}`,
          )
        }
        return toIssueComment(existing)
      },
      delete: async (commentId) => {
        await database.delete(issueComments).where(eq(issueComments.id, commentId))
      },
    },

    runs: {
      listByIssue: async issueId => (await database
        .select()
        .from(issueRuns)
        .where(eq(issueRuns.issueId, issueId))
        .orderBy(asc(issueRuns.startedAt), asc(issueRuns.seq))).map(toIssueRun),
      listRunning: async issueId => (await database
        .select()
        .from(issueRuns)
        .where(and(eq(issueRuns.issueId, issueId), eq(issueRuns.state, 'running')))
        .orderBy(asc(issueRuns.startedAt), asc(issueRuns.seq))).map(toIssueRun),
      listRunningWithSession: async () => (await database
        .select()
        .from(issueRuns)
        .where(and(eq(issueRuns.state, 'running'), isNotNull(issueRuns.chatSessionId)))
        .orderBy(asc(issueRuns.startedAt), asc(issueRuns.seq))).map(toIssueRun),
      findById: async (runId) => {
        const [row] = await database.select().from(issueRuns).where(eq(issueRuns.id, runId)).limit(1)
        return row ? toIssueRun(row) : null
      },
      findByChatSessionId: async (chatSessionId) => {
        const [row] = await database
          .select()
          .from(issueRuns)
          .where(eq(issueRuns.chatSessionId, chatSessionId))
          .orderBy(desc(issueRuns.startedAt), desc(issueRuns.seq))
          .limit(1)
        return row ? toIssueRun(row) : null
      },
      countByIssue: async (issueId) => {
        const [row] = await database
          .select({ count: sql<number>`cast(count(*) as int)` })
          .from(issueRuns)
          .where(eq(issueRuns.issueId, issueId))
        return row?.count ?? 0
      },
      create: async (values) => {
        const [row] = await database.insert(issueRuns).values(values).returning()
        return toIssueRun(row)
      },
      update: async (runId, patch) => {
        await database.update(issueRuns).set(patch).where(eq(issueRuns.id, runId))
      },
      project: async scope => await selectRunProjection(database, scope),
    },

    relations: {
      listByIssue: async issueId => await database
        .select()
        .from(issueRelations)
        .where(or(eq(issueRelations.sourceIssueId, issueId), eq(issueRelations.targetIssueId, issueId))),
      findById: async (relationId) => {
        const [row] = await database.select().from(issueRelations).where(eq(issueRelations.id, relationId)).limit(1)
        return row ?? null
      },
      findMatching: async (edge) => {
        const [row] = await database
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
          .limit(1)
        return row ?? null
      },
      create: async (values) => {
        const [row] = await database.insert(issueRelations).values(values).returning()
        return row
      },
      delete: async (relationId) => {
        await database.delete(issueRelations).where(eq(issueRelations.id, relationId))
      },
      deleteByIssue: async (issueId) => {
        await database
          .delete(issueRelations)
          .where(or(eq(issueRelations.sourceIssueId, issueId), eq(issueRelations.targetIssueId, issueId)))
      },
    },

    contextRefs: {
      replace: async (issueId, contextRefs, updatedAt) => {
        await database.update(issues).set({ contextRefs, updatedAt }).where(eq(issues.id, issueId))
      },
    },

    fieldChanges: {
      listByIssue: async issueId => (await database
        .select()
        .from(issueFieldChanges)
        .where(eq(issueFieldChanges.issueId, issueId))
        .orderBy(asc(issueFieldChanges.createdAt), asc(issueFieldChanges.seq))).map(toIssueFieldChange),
      listByIssueField: async (issueId, field) => (await database
        .select()
        .from(issueFieldChanges)
        .where(and(eq(issueFieldChanges.issueId, issueId), eq(issueFieldChanges.field, field)))
        .orderBy(asc(issueFieldChanges.createdAt), asc(issueFieldChanges.seq))).map(toIssueFieldChange),
      create: async (values) => {
        await database.insert(issueFieldChanges).values(values)
      },
    },

    pullRequests: {
      listByIssue: async issueId => (await database
        .select()
        .from(issuePullRequests)
        .where(eq(issuePullRequests.issueId, issueId))
        .orderBy(asc(issuePullRequests.createdAt), asc(issuePullRequests.seq))).map(toIssuePullRequest),
      listLinked: async () => (await database
        .select({ ...getTableColumns(issuePullRequests), workspaceId: issues.workspaceId })
        .from(issuePullRequests)
        .innerJoin(issues, eq(issues.id, issuePullRequests.issueId))
        .orderBy(asc(issuePullRequests.createdAt), asc(issuePullRequests.seq))).map(toLinkedPullRequest),
      link: async (values) => {
        // `do nothing` returns no row when the card already names the pull
        // request, and the read below then finds the link that does. A conflict
        // it absorbs leaves the transaction usable, so no savepoint is needed.
        const [inserted] = await database.insert(issuePullRequests).values(values).onConflictDoNothing().returning()
        if (inserted) {
          return toIssuePullRequest(inserted)
        }
        const [existing] = await database
          .select()
          .from(issuePullRequests)
          .where(and(
            eq(issuePullRequests.issueId, values.issueId),
            eq(issuePullRequests.owner, values.owner),
            eq(issuePullRequests.repo, values.repo),
            eq(issuePullRequests.number, values.number),
          ))
          .limit(1)
        if (!existing) {
          // Refused, and not by the one index that makes a link idempotent.
          throw new Error(
            `pull request link for ${values.issueId} was refused, and the card names no ${values.owner}/${values.repo}#${values.number}`,
          )
        }
        return toIssuePullRequest(existing)
      },
      unlink: async (issueId, linkId) => {
        const [removed] = await database
          .delete(issuePullRequests)
          .where(and(eq(issuePullRequests.id, linkId), eq(issuePullRequests.issueId, issueId)))
          .returning()
        return removed ? toIssuePullRequest(removed) : null
      },
    },

    meta: {
      read: async (key) => {
        const [row] = await database.select().from(kanbanMeta).where(eq(kanbanMeta.key, key)).limit(1)
        return row ?? null
      },
      bumpRevision: async (key, updatedAt) => {
        await database
          .insert(kanbanMeta)
          .values({ key, revision: 1, updatedAt })
          .onConflictDoUpdate({
            target: kanbanMeta.key,
            set: { revision: sql`${kanbanMeta.revision} + 1`, updatedAt },
          })
      },
    },

    /**
     * Run `fn` inside one Postgres transaction, on the handle this store is
     * bound to. A transaction opened on a transactional handle is a savepoint —
     * drizzle writes that for us — so a nested write rolls back on its own
     * without taking the outer one with it.
     *
     * `mode` reaches nothing here. `immediate` is SQLite's way of taking the
     * file's write lock up front, and Postgres has no counterpart worth writing:
     * it locks rows as they are written, and the two races the board actually
     * has — two writers numbering a card, two writers bumping the change
     * counter — are settled by the unique index on `(workspace_id, number)` and
     * by the `on conflict do update` on `kanban_meta`. Nothing here takes a lock
     * the statement itself would not.
     */
    transaction: async <T>(
      fn: (tx: BoardStore) => Promise<T>,
      _options?: { mode?: BoardTransactionMode },
    ): Promise<T> => {
      return await database.transaction(async tx => await fn(createStoreOver(tx)))
    },
  }

  return store
}

/**
 * `BoardStore` backed by Postgres — the board in a database several machines
 * share, rather than in a file one machine holds.
 *
 * It is written against `pg-core` and nothing below it, so the same store serves
 * a real connection onto an external database and the embedded
 * Postgres the tests run on. Every method answers what the SQLite store
 * answers, down to the order of two rows written in the same second — `seq` on
 * `issue_runs`, `issue_comments`, `issue_field_changes` and
 * `issue_pull_requests` is what stands in for `rowid` there.
 */
export function createPostgresBoardStore(options: { database: BoardPostgresDatabase }): BoardStore {
  return createStoreOver(options.database)
}

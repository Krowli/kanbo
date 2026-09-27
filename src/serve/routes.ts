import type { BoardSession } from '../cli/command'
import { BoardError } from '../domain/errors'
import { normalizeStatusName } from '../domain/status-name'
import { readChangeSeq, runBoardWrite } from '../ops/change-seq'
import type { BoardRunView } from '../ops/runs'
import type { Issue, IssueComment, IssueMilestone, IssueRelation, IssueRun, IssueStatus } from '../sqlite/schema'
import { ServeError } from './errors'
import type { Route } from './router'
import { route } from './router'
import {
  addCommentBody,
  addContextRefBody,
  addPullRequestBody,
  approveBody,
  bulkUpdateBody,
  closeSprintBody,
  createIssueBody,
  createMilestoneBody,
  createRelationBody,
  createStatusBody,
  finishRunBody,
  listIssuesQuery,
  readyQuery,
  removeStatusBody,
  removeStatusQuery,
  reorderIssuesBody,
  reorderStatusesBody,
  requiredWorkspaceIdQuery,
  returnBody,
  searchQuery,
  setStatusLineBody,
  startRunBody,
  updateIssueBody,
  updateMilestoneBody,
  updateStatusBody,
  waitApprovalBody,
  workspaceIdBody,
  workspaceIdQuery,
  workspaceIdsQuery,
} from './schemas'
import type { ServeCardView } from './views'
import {
  createActivityResolver,
  toCardView,
  toCardViews,
  toCommentView,
  toStatusView,
  toWrittenCardView,
} from './views'

/**
 * The board's `/issues` routes, for one board and one workspace.
 *
 * Every route the board operations can answer on their own. An app that serves
 * the same routes may hold every workspace of every board it can reach; this
 * server holds the one board and the one workspace it was started on. A
 * `workspaceId` naming any other is `issue_workspace_not_found`, and an id —
 * a card, a column, a milestone, a comment, a relation, a run — that belongs to
 * another workspace of the same database is not found either, exactly as if
 * the row were not there: one database may hold every project's board, and
 * a server started for one of them must not reach into the rest.
 */

const OK = { ok: true as const }

/** How many cards a search answers with when the caller names no limit. */
const DEFAULT_SEARCH_LIMIT = 20

export function createIssueRoutes(session: BoardSession): Route[] {
  const { ops, store, workspace } = session
  const workspaceId = workspace.id
  const activityResolver = createActivityResolver(workspace)

  /** The served workspace, when that is the one the caller named — or named none. */
  function requireWorkspace(named: string | undefined): string {
    if (named !== undefined && named !== workspaceId) {
      throw new BoardError('issue_workspace_not_found', { workspaceId: named })
    }
    return workspaceId
  }

  async function requireCard(issueId: string): Promise<Issue> {
    const card = await store.issues.findInWorkspace(workspaceId, issueId)
    if (!card) {
      throw new BoardError('issue_not_found', { issueId })
    }
    return card
  }

  async function requireStatus(statusId: string): Promise<IssueStatus> {
    const status = await store.statuses.findInWorkspace(workspaceId, statusId)
    if (!status) {
      throw new BoardError('issue_status_not_found', { statusId })
    }
    return status
  }

  async function requireMilestone(milestoneId: string): Promise<IssueMilestone> {
    const milestone = await store.milestones.findInWorkspace(workspaceId, milestoneId)
    if (!milestone) {
      throw new BoardError('issue_milestone_not_found', { milestoneId })
    }
    return milestone
  }

  /** Whether a row hanging off a card — a comment, a relation, a run — hangs off one of this workspace's. */
  async function isOnThisBoard(issueId: string): Promise<boolean> {
    return (await store.issues.findInWorkspace(workspaceId, issueId)) !== null
  }

  async function requireComment(commentId: string): Promise<IssueComment> {
    const comment = await store.comments.findById(commentId)
    if (!comment || !await isOnThisBoard(comment.issueId)) {
      throw new BoardError('issue_comment_not_found', { commentId })
    }
    return comment
  }

  async function requireRelation(relationId: string): Promise<IssueRelation> {
    const relation = await store.relations.findById(relationId)
    if (!relation || !await isOnThisBoard(relation.sourceIssueId)) {
      throw new BoardError('issue_relation_not_found', { relationId })
    }
    return relation
  }

  async function requireRun(runId: string): Promise<IssueRun> {
    const run = await store.runs.findById(runId)
    if (!run || !await isOnThisBoard(run.issueId)) {
      throw new BoardError('board_run_not_found', { runId })
    }
    return run
  }

  /**
   * Seed the standard columns before answering about them, the first time
   * anyone looks. It is a write, so it asks the schema guard — but
   * only when there is something to seed: a board older than this build that
   * already has columns is still one worth reading.
   */
  async function seedColumns(): Promise<void> {
    if (await store.statuses.countByWorkspace(workspaceId) === 0) {
      await session.assertWritable()
      await ops.ensureDefaultColumns(workspaceId)
    }
  }

  async function listStatusViews() {
    await seedColumns()
    return (await ops.listColumns(workspaceId)).map(toStatusView)
  }

  /** A run with the attempt number it is, counting from the card's first launch. */
  async function toRunView(run: IssueRun): Promise<BoardRunView> {
    const runs = await ops.listRuns(run.issueId)
    return { ...run, attempt: runs.findIndex(candidate => candidate.id === run.id) + 1 }
  }

  return [
    // Columns
    route({
      method: 'GET',
      path: '/issues/statuses',
      query: workspaceIdQuery,
      handle: async ({ query }) => {
        requireWorkspace(query.workspaceId)
        return await listStatusViews()
      },
    }),
    route({
      method: 'POST',
      path: '/issues/statuses',
      body: createStatusBody,
      write: true,
      handle: async ({ body, actors }) => toStatusView(await ops.createColumn({
        workspaceId: requireWorkspace(body.workspaceId),
        name: body.name,
        description: body.description ?? null,
        color: body.color ?? null,
        category: body.category ?? 'unstarted',
        entryRules: body.entryRules ?? null,
      }, actors.person)),
    }),
    route({
      method: 'POST',
      path: '/issues/statuses/reorder',
      body: reorderStatusesBody,
      write: true,
      handle: async ({ body, actors }) => {
        requireWorkspace(body.workspaceId)
        for (const statusId of body.orderedIds) {
          await requireStatus(statusId)
        }
        await ops.reorderColumns(workspaceId, body.orderedIds, undefined, actors.person)
        return OK
      },
    }),
    route({
      method: 'POST',
      path: '/issues/statuses/standard',
      body: workspaceIdBody,
      write: true,
      handle: async ({ body, actors }) =>
        (await ops.addStandardColumns(requireWorkspace(body.workspaceId), undefined, actors.person)).statuses.map(toStatusView),
    }),
    route({
      method: 'PATCH',
      path: '/issues/statuses/:id',
      body: updateStatusBody,
      write: true,
      handle: async ({ params, body, actors }) => {
        await requireStatus(params.id)
        // A new name is held to `renameColumn`'s rules and is a person's to give.
        return toStatusView(await ops.updateColumn(params.id, body, actors.person))
      },
    }),
    route({
      method: 'DELETE',
      path: '/issues/statuses/:id',
      query: removeStatusQuery,
      body: removeStatusBody,
      write: true,
      handle: async ({ params, query, body, actors }) => {
        await requireStatus(params.id)
        const moveCardsTo = body.moveCardsTo ?? query.moveCardsTo ?? null
        const result = await ops.removeColumn(workspaceId, params.id, { moveCardsTo }, actors.person)
        return {
          ok: true as const,
          movedCards: result.movedCards,
          ...(result.unmetRules ? { unmetRules: result.unmetRules } : {}),
        }
      },
    }),

    // Milestones, and milestones read as sprints
    route({
      method: 'GET',
      path: '/issues/milestones',
      query: workspaceIdQuery,
      handle: async ({ query }) => await ops.listMilestones(requireWorkspace(query.workspaceId)),
    }),
    route({
      method: 'POST',
      path: '/issues/milestones',
      body: createMilestoneBody,
      write: true,
      handle: async ({ body }) => await ops.createMilestone({
        workspaceId: requireWorkspace(body.workspaceId),
        title: body.title,
        description: body.description ?? null,
        startDate: body.startDate ?? null,
        dueDate: body.dueDate ?? null,
        status: body.status ?? 'open',
      }),
    }),
    route({
      method: 'PATCH',
      path: '/issues/milestones/:id',
      body: updateMilestoneBody,
      write: true,
      handle: async ({ params, body }) => {
        await requireMilestone(params.id)
        return await ops.updateMilestone(params.id, body)
      },
    }),
    route({
      method: 'DELETE',
      path: '/issues/milestones/:id',
      write: true,
      handle: async ({ params }) => {
        await requireMilestone(params.id)
        await ops.deleteMilestone(params.id)
        return OK
      },
    }),
    route({
      method: 'GET',
      path: '/issues/sprints',
      query: requiredWorkspaceIdQuery,
      handle: async ({ query }) => await ops.listSprints(requireWorkspace(query.workspaceId)),
    }),
    route({
      method: 'POST',
      path: '/issues/milestones/:id/close',
      body: closeSprintBody,
      write: true,
      handle: async ({ params, body, actors }) => {
        await requireMilestone(params.id)
        return await ops.closeSprint(params.id, body, actors.person)
      },
    }),

    // The board as a whole
    route({
      method: 'GET',
      path: '/issues/columns',
      query: workspaceIdsQuery,
      handle: async ({ query }) => {
        // Naming no workspace is a board of no columns.
        if (query.workspaceIds.length === 0) {
          return []
        }
        for (const named of query.workspaceIds) {
          requireWorkspace(named)
        }
        return (await listStatusViews()).map(status => ({
          name: status.name,
          normalizedName: normalizeStatusName(status.name),
          category: status.category,
          color: status.color,
          statuses: [{ workspaceId, statusId: status.id, entryRules: status.entryRules }],
        }))
      },
    }),
    route({
      method: 'GET',
      path: '/issues/search',
      query: searchQuery,
      handle: async ({ query }) => {
        const limit = Number(query.limit) || DEFAULT_SEARCH_LIMIT
        const found = (await ops.searchCards(query.q, Number.POSITIVE_INFINITY))
          .filter(card => card.workspaceId === workspaceId)
          .slice(0, limit)
        return await toCardViews(ops, found)
      },
    }),
    route({
      method: 'GET',
      path: '/issues/version',
      query: workspaceIdQuery,
      handle: async ({ query }) => {
        requireWorkspace(query.workspaceId)
        return { seq: await readChangeSeq(store) }
      },
    }),
    route({
      method: 'GET',
      path: '/issues/ready',
      query: readyQuery,
      handle: async ({ query }) => {
        requireWorkspace(query.workspaceId)
        await seedColumns()
        return await toCardViews(ops, await ops.listReady({ workspaceId, limit: query.limit }))
      },
    }),
    route({
      method: 'GET',
      path: '/issues/prime',
      query: requiredWorkspaceIdQuery,
      handle: async ({ query }) => {
        requireWorkspace(query.workspaceId)
        await seedColumns()
        return { text: await ops.buildPrimeText(workspaceId) }
      },
    }),

    // Cards
    route({
      method: 'GET',
      path: '/issues',
      query: listIssuesQuery,
      handle: async ({ query }) => {
        if (query.workspaceId !== undefined && query.workspaceIds !== undefined) {
          throw new ServeError(400, 'issue_workspace_filter_conflict', 'Use either workspaceId or workspaceIds, not both', {
            workspaceId: query.workspaceId,
            workspaceIds: query.workspaceIds,
          })
        }
        requireWorkspace(query.workspaceId)
        for (const named of query.workspaceIds ?? []) {
          requireWorkspace(named)
        }
        const cards = (await store.issues.listInBoardOrder(workspaceId))
          .filter(card => query.milestoneId === undefined || card.milestoneId === query.milestoneId)
          .filter(card => query.parentIssueId === undefined || card.parentIssueId === query.parentIssueId)
          .filter(card => query.priority === undefined || card.priority === query.priority)
          .filter(card => query.statusId === undefined || card.statusId === query.statusId)
        const views = await toCardViews(ops, cards)
        const labels = query.labels ?? []
        return views.filter(view => labels.every(label => view.labels.includes(label)))
      },
    }),
    route({
      method: 'POST',
      path: '/issues/reorder',
      body: reorderIssuesBody,
      write: true,
      handle: async ({ body, actors }) => {
        requireWorkspace(body.workspaceId)
        await ops.reorderCards(workspaceId, body.orderedIds)
        // Field changes go through the card update, so history and entry
        // rules are exactly an inline edit's.
        const updated: ServeCardView[] = []
        if (body.patch) {
          for (const issueId of new Set(body.patch.issueIds)) {
            await requireCard(issueId)
            updated.push(await toWrittenCardView(ops, await ops.updateCard(issueId, body.patch.fields, actors.placement)))
          }
        }
        return updated
      },
    }),
    route({
      method: 'GET',
      path: '/issues/:id',
      handle: async ({ params }) => await toCardView(ops, await requireCard(params.id)),
    }),
    route({
      method: 'POST',
      path: '/issues',
      body: createIssueBody,
      write: true,
      handle: async ({ body, actors }) => {
        const { workspaceId: named, ...fields } = body
        requireWorkspace(named)
        return await toWrittenCardView(ops, await ops.createCard({ ...fields, workspace }, actors.placement))
      },
    }),
    route({
      method: 'PATCH',
      path: '/issues/bulk',
      body: bulkUpdateBody,
      write: true,
      handle: async ({ body, actors }) => {
        // A card of another workspace is skipped, the way the board skips an
        // id it does not hold at all.
        const onThisBoard: string[] = []
        for (const issueId of new Set(body.issueIds)) {
          if (await isOnThisBoard(issueId)) {
            onThisBoard.push(issueId)
          }
        }
        return await ops.bulkUpdateCards(onThisBoard, body.update, actors.placement)
      },
    }),
    route({
      method: 'PATCH',
      path: '/issues/runs/:runId',
      body: finishRunBody,
      write: true,
      handle: async ({ params, body, actors }) => {
        await requireRun(params.runId)
        // What the run turned out to be running in and how it ended are one
        // write.
        const run = await runBoardWrite(store, async (scope) => {
          if (body.branch !== undefined || body.worktreePath !== undefined || body.externalSessionRef !== undefined) {
            await ops.attachRunExecution(params.runId, body, scope)
          }
          return await ops.finishRun(params.runId, body, actors.writer, scope)
        })
        return await toRunView(run)
      },
    }),
    route({
      method: 'PATCH',
      path: '/issues/:id/status/:statusName',
      write: true,
      handle: async ({ params, actors }) => {
        await requireCard(params.id)
        return await toWrittenCardView(ops, await ops.moveCard(params.id, params.statusName, actors.placement))
      },
    }),
    route({
      method: 'PATCH',
      path: '/issues/:id/status-line',
      body: setStatusLineBody,
      write: true,
      handle: async ({ params, body, actors }) => {
        await requireCard(params.id)
        return await toCardView(ops, await ops.setStatusLine(params.id, body.statusLine, actors.writer))
      },
    }),
    route({
      method: 'POST',
      path: '/issues/:id/wait-approval',
      body: waitApprovalBody,
      write: true,
      handle: async ({ params, body, actors }) => {
        await requireCard(params.id)
        return await toCardView(ops, await ops.waitApproval(params.id, body, actors.writer))
      },
    }),
    route({
      method: 'POST',
      path: '/issues/:id/approve',
      body: approveBody,
      write: true,
      handle: async ({ params, body, actors }) => {
        await requireCard(params.id)
        return await toCardView(ops, await ops.approve(params.id, body, actors.person))
      },
    }),
    route({
      method: 'POST',
      path: '/issues/:id/return',
      body: returnBody,
      write: true,
      handle: async ({ params, body, actors }) => {
        await requireCard(params.id)
        return await toCardView(ops, (await ops.returnCard(params.id, body, actors.person)).card)
      },
    }),
    route({
      method: 'GET',
      path: '/issues/:id/runs',
      handle: async ({ params }) => {
        await requireCard(params.id)
        return await ops.listRuns(params.id)
      },
    }),
    route({
      method: 'POST',
      path: '/issues/:id/runs',
      body: startRunBody,
      write: true,
      handle: async ({ params, body, actors }) => {
        await requireCard(params.id)
        return await toRunView(await ops.startRun(params.id, body, actors.writer))
      },
    }),
    route({
      method: 'PATCH',
      path: '/issues/:id',
      body: updateIssueBody,
      write: true,
      handle: async ({ params, body, actors }) => {
        await requireCard(params.id)
        if (body.workspaceId !== undefined) {
          requireWorkspace(body.workspaceId)
        }
        return await toWrittenCardView(ops, await ops.updateCard(params.id, body, actors.placement))
      },
    }),
    route({
      method: 'GET',
      path: '/issues/:id/activity',
      handle: async ({ params }) => {
        await requireCard(params.id)
        return await ops.listActivity(params.id, activityResolver)
      },
    }),
    route({
      method: 'GET',
      path: '/issues/:id/field-changes',
      handle: async ({ params }) => {
        await requireCard(params.id)
        return await ops.listFieldChanges(params.id)
      },
    }),
    route({
      method: 'DELETE',
      path: '/issues/:id',
      write: true,
      handle: async ({ params, actors }) => {
        await requireCard(params.id)
        // No board tool or command deletes a card: a card that could be
        // deleted and written again is a way around waiting for a person, and
        // the agent role holds no `delete` on `issues` for the same reason. So
        // this route is a person's, like approval — the one refusal the board
        // does not make itself, because nothing else in the package deletes.
        if (actors.person.kind !== 'user') {
          throw new ServeError(403, 'issue_delete_requires_user', 'Only a person can delete a card', { issueId: params.id })
        }
        await ops.deleteCard(params.id)
        return OK
      },
    }),

    // Comments
    route({
      method: 'GET',
      path: '/issues/:id/comments',
      handle: async ({ params }) => {
        await requireCard(params.id)
        return (await ops.listComments(params.id)).map(toCommentView)
      },
    }),
    route({
      method: 'POST',
      path: '/issues/:id/comments',
      body: addCommentBody,
      write: true,
      handle: async ({ params, body, actors }) => {
        await requireCard(params.id)
        return toCommentView(await ops.addComment({ issueId: params.id, content: body.content }, actors.writer))
      },
    }),
    route({
      method: 'DELETE',
      path: '/issues/comments/:id',
      write: true,
      handle: async ({ params, actors }) => {
        await requireComment(params.id)
        await ops.deleteComment(params.id, actors.person)
        return OK
      },
    }),

    // What a card points at
    route({
      method: 'GET',
      path: '/issues/:id/relations',
      handle: async ({ params }) => {
        await requireCard(params.id)
        return await ops.listRelations(params.id)
      },
    }),
    route({
      method: 'POST',
      path: '/issues/relations',
      body: createRelationBody,
      write: true,
      handle: async ({ body }) => {
        await requireCard(body.sourceIssueId)
        await requireCard(body.targetIssueId)
        return await ops.createRelation(body)
      },
    }),
    route({
      method: 'DELETE',
      path: '/issues/relations/:id',
      write: true,
      handle: async ({ params }) => {
        await requireRelation(params.id)
        await ops.deleteRelation(params.id)
        return OK
      },
    }),
    route({
      method: 'GET',
      path: '/issues/:id/pull-requests',
      handle: async ({ params }) => {
        await requireCard(params.id)
        return await ops.listPullRequestStandings(params.id)
      },
    }),
    route({
      method: 'POST',
      path: '/issues/:id/pull-requests',
      body: addPullRequestBody,
      write: true,
      handle: async ({ params, body, actors }) => {
        await requireCard(params.id)
        return await ops.linkPullRequest(params.id, body.url, actors.writer)
      },
    }),
    route({
      method: 'DELETE',
      path: '/issues/:id/pull-requests/:linkId',
      write: true,
      handle: async ({ params, actors }) => {
        await requireCard(params.id)
        await ops.unlinkPullRequest(params.id, params.linkId, actors.person)
        return OK
      },
    }),
    route({
      method: 'POST',
      path: '/issues/:id/context-refs',
      body: addContextRefBody,
      write: true,
      handle: async ({ params, body, actors }) => {
        await requireCard(params.id)
        return await toCardView(ops, await ops.addContextRef(params.id, body.ref, actors.writer))
      },
    }),
    route({
      method: 'DELETE',
      path: '/issues/:id/context-refs/:index',
      write: true,
      handle: async ({ params, actors }) => {
        await requireCard(params.id)
        return await toCardView(ops, await ops.removeContextRef(params.id, Number(params.index), actors.writer))
      },
    }),
  ]
}

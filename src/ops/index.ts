import type { BoardStore } from '../board-store'
import type { ColumnSpec } from '../domain/column-templates'
import type { Issue } from '../sqlite/schema'
import type { IssueActivityResolver } from './activity'
import { listActivity, listFieldChanges } from './activity'
import { readApproval, readCardAttention } from './approval'
import type { BulkUpdateCardsInput } from './card-batch'
import { bulkUpdateCards, reorderCards } from './card-batch'
import type { AddCommentInput, CreateCardInput, CreateCommentOnceInput, UpdateCardInput } from './cards'
import {
  addComment,
  approve,
  assertReturnable,
  createCard,
  createCommentOnce,
  createSubCard,
  deleteCard,
  deleteComment,
  listComments,
  moveCard,
  returnCard,
  searchCards,
  setStatusLine,
  updateCard,
  waitApproval,
} from './cards'
import type { BoardWriteScope } from './change-seq'
import type { AddColumnInput, ApplyColumnTemplateOptions, BoardColumnInput, BoardColumnPatch, ColumnPosition, RemoveColumnOptions } from './columns'
import {
  addColumn,
  addStandardColumns,
  applyColumnTemplate,
  createColumn,
  deleteColumn,
  describeColumn,
  ensureDefaultColumns,
  findColumn,
  listColumns,
  moveColumn,
  removeColumn,
  renameColumn,
  reorderColumns,
  requireColumn,
  setColumnEntryRules,
  updateColumn,
} from './columns'
import { addContextRef, removeContextRef } from './context-refs'
import { enforceColumnEntryForCards } from './entry-rules'
import type { MigrateCardsInput } from './migrate'
import { migrateCards } from './migrate'
import { buildPrimeText } from './prime'
import { linkPullRequest, listPullRequests, listPullRequestStandings, unlinkPullRequest } from './pull-requests'
import type { CardQueryInput } from './card-query'
import { queryCards } from './card-query'
import { listReady, queryReady } from './ready'
import type { CreateRelationInput } from './relations'
import { createRelation, deleteRelation, listRelations } from './relations'
import type { AttachRunExecutionInput, FinishRunInput, StartRunInput } from './runs'
import {
  attachRunExecution,
  clearRunSessionRef,
  findRunByChatSessionId,
  finishRun,
  listRuns,
  readBoardProjection,
  readBoardProjectionForIssue,
  readBoardProjectionForIssues,
  recordRunSessionRef,
  startRun,
  stopRunningRuns,
} from './runs'
import type { CreateMilestoneInput, UpdateMilestoneInput } from './sprints'
import { closeSprint, createMilestone, currentSprint, deleteMilestone, listMilestones, listSprints, updateMilestone } from './sprints'
import type { BoardActor } from './types'

/**
 * Everything the board can be asked to do, bound to one store.
 *
 * This is the layer the semantics live in — numbering, columns, the status line,
 * approval, runs — and there is exactly one of it. `kanbo serve`, an app's server, the
 * command-line tool and the MCP server all call these operations rather than
 * writing rows of their own, which is why a card launched from a terminal and a
 * card launched from the app end up telling the same story.
 *
 * Every write takes an actor, and every write may take a `scope`: passing the
 * scope of a write already in progress joins it, so a caller composing several
 * operations gets one transaction and one board version bump.
 */
export function createBoardOps<TStore extends BoardStore>(store: TStore) {
  type Scope = BoardWriteScope<TStore>

  return {
    // Cards
    createCard: async (input: CreateCardInput, actor: BoardActor, scope?: Scope) =>
      await createCard(store, input, actor, scope),
    createSubCard: async (parentIssueId: string, input: Omit<CreateCardInput, 'parentIssueId'>, actor: BoardActor, scope?: Scope) =>
      await createSubCard(store, parentIssueId, input, actor, scope),
    updateCard: async (issueId: string, input: UpdateCardInput, actor: BoardActor, scope?: Scope) =>
      await updateCard(store, issueId, input, actor, scope),
    moveCard: async (issueId: string, nameOrId: string, actor: BoardActor, scope?: Scope) =>
      await moveCard(store, issueId, nameOrId, actor, scope),
    addComment: async (input: AddCommentInput, actor: BoardActor, scope?: Scope) =>
      await addComment(store, input, actor, scope),
    createCommentOnce: async (input: CreateCommentOnceInput, scope?: Scope) =>
      await createCommentOnce(store, input, scope),
    listComments: async (issueId: string) => await listComments(store, issueId),
    deleteComment: async (commentId: string, actor: BoardActor, scope?: Scope) =>
      await deleteComment(store, commentId, actor, scope),
    deleteCard: async (issueId: string, scope?: Scope) => await deleteCard(store, issueId, scope),
    searchCards: async (query: string, limit: number) => await searchCards(store, query, limit),
    queryCards: async (input: CardQueryInput) => await queryCards(store, input),

    // Many cards at once
    bulkUpdateCards: async (issueIds: string[], input: BulkUpdateCardsInput, actor: BoardActor, scope?: Scope) =>
      await bulkUpdateCards(store, issueIds, input, actor, scope),
    reorderCards: async (workspaceId: string, orderedIds: string[], scope?: Scope) =>
      await reorderCards(store, workspaceId, orderedIds, scope),
    migrateCards: async (input: MigrateCardsInput) => await migrateCards(store, input),

    // What a card points at, and what it has been through
    addContextRef: async (issueId: string, ref: string, actor: BoardActor, scope?: Scope) =>
      await addContextRef(store, issueId, ref, actor, scope),
    removeContextRef: async (issueId: string, index: number, actor: BoardActor, scope?: Scope) =>
      await removeContextRef(store, issueId, index, actor, scope),
    listRelations: async (issueId: string) => await listRelations(store, issueId),
    createRelation: async (input: CreateRelationInput, scope?: Scope) => await createRelation(store, input, scope),
    deleteRelation: async (relationId: string, scope?: Scope) => await deleteRelation(store, relationId, scope),
    listFieldChanges: async (issueId: string) => await listFieldChanges(store, issueId),
    listActivity: async (issueId: string, resolver: IssueActivityResolver) => await listActivity(store, issueId, resolver),

    // The card's own state: what it is doing, and whose turn it is
    setStatusLine: async (issueId: string, statusLine: string | null, actor: BoardActor, scope?: Scope) =>
      await setStatusLine(store, issueId, statusLine, actor, scope),
    waitApproval: async (issueId: string, input: { statusLine?: string | null }, actor: BoardActor, scope?: Scope) =>
      await waitApproval(store, issueId, input, actor, scope),
    approve: async (issueId: string, input: { comment?: string | null }, actor: BoardActor, scope?: Scope) =>
      await approve(store, issueId, input, actor, scope),
    returnCard: async (issueId: string, input: { comment: string, toStatusName?: string | null }, actor: BoardActor, scope?: Scope) =>
      await returnCard(store, issueId, input, actor, scope),
    assertReturnable: async (issueId: string, input: { toStatusName?: string | null }, actor: BoardActor) =>
      await assertReturnable(store, issueId, input, actor),
    readApproval: async (issueId: string) => await readApproval(store, issueId),
    readCardAttention: async (cards: readonly Issue[], running: readonly boolean[]) => await readCardAttention(store, cards, running),

    // The pull requests a card names
    linkPullRequest: async (issueId: string, urlOrRef: string, actor: BoardActor, scope?: Scope) =>
      await linkPullRequest(store, issueId, urlOrRef, actor, scope),
    unlinkPullRequest: async (issueId: string, linkId: string, actor: BoardActor, scope?: Scope) =>
      await unlinkPullRequest(store, issueId, linkId, actor, scope),
    listPullRequests: async (issueId: string) => await listPullRequests(store, issueId),
    listPullRequestStandings: async (issueId: string) => await listPullRequestStandings(store, issueId),

    // Milestones, and milestones read as sprints
    listMilestones: async (workspaceId: string | null) => await listMilestones(store, workspaceId),
    deleteMilestone: async (milestoneId: string, scope?: Scope) => await deleteMilestone(store, milestoneId, scope),
    createMilestone: async (input: CreateMilestoneInput, scope?: Scope) => await createMilestone(store, input, scope),
    updateMilestone: async (milestoneId: string, input: UpdateMilestoneInput, scope?: Scope) =>
      await updateMilestone(store, milestoneId, input, scope),
    listSprints: async (workspaceId: string, now?: number) => await listSprints(store, workspaceId, now),
    currentSprint: async (workspaceId: string, now?: number) => await currentSprint(store, workspaceId, now),
    closeSprint: async (milestoneId: string, input: { carryTo?: string | null }, actor: BoardActor, scope?: Scope) =>
      await closeSprint(store, milestoneId, input, actor, scope),

    // Columns
    listColumns: async (workspaceId: string) => await listColumns(store, workspaceId),
    findColumn: async (workspaceId: string, nameOrId: string) => await findColumn(store, workspaceId, nameOrId),
    requireColumn: async (workspaceId: string, nameOrId: string) => await requireColumn(store, workspaceId, nameOrId),
    ensureDefaultColumns: async (workspaceId: string, scope?: Scope) => await ensureDefaultColumns(store, workspaceId, scope),
    createColumn: async (input: BoardColumnInput, actor: BoardActor, scope?: Scope) => await createColumn(store, input, actor, scope),
    updateColumn: async (statusId: string, patch: BoardColumnPatch, actor: BoardActor, scope?: Scope) =>
      await updateColumn(store, statusId, patch, actor, scope),
    describeColumn: async (workspaceId: string, nameOrId: string, description: string | null, scope?: Scope) =>
      await describeColumn(store, workspaceId, nameOrId, description, scope),
    setColumnEntryRules: async (workspaceId: string, nameOrId: string, entryRules: readonly string[] | null, actor: BoardActor, scope?: Scope) =>
      await setColumnEntryRules(store, workspaceId, nameOrId, entryRules, actor, scope),
    enforceColumnEntryForCards: async (issueIds: string[], statusId: string, actor: BoardActor) =>
      await enforceColumnEntryForCards(store, issueIds, statusId, actor),
    deleteColumn: async (statusId: string, scope?: Scope, actor?: BoardActor) => await deleteColumn(store, statusId, scope, actor),
    reorderColumns: async (workspaceId: string, orderedIds: string[], scope?: Scope, actor?: BoardActor) =>
      await reorderColumns(store, workspaceId, orderedIds, scope, actor),
    addStandardColumns: async (workspaceId: string, scope?: Scope, actor?: BoardActor) =>
      await addStandardColumns(store, workspaceId, scope, actor),
    addColumn: async (workspaceId: string, input: AddColumnInput, actor: BoardActor, scope?: Scope) =>
      await addColumn(store, workspaceId, input, actor, scope),
    applyColumnTemplate: async (workspaceId: string, columns: readonly ColumnSpec[], options: ApplyColumnTemplateOptions, scope?: Scope) =>
      await applyColumnTemplate(store, workspaceId, columns, options, scope),
    renameColumn: async (workspaceId: string, nameOrId: string, newName: string, actor: BoardActor, scope?: Scope) =>
      await renameColumn(store, workspaceId, nameOrId, newName, actor, scope),
    moveColumn: async (workspaceId: string, nameOrId: string, position: ColumnPosition, actor: BoardActor, scope?: Scope) =>
      await moveColumn(store, workspaceId, nameOrId, position, actor, scope),
    removeColumn: async (workspaceId: string, nameOrId: string, options: RemoveColumnOptions, actor: BoardActor, scope?: Scope) =>
      await removeColumn(store, workspaceId, nameOrId, options, actor, scope),

    // Runs
    startRun: async (issueId: string, input: StartRunInput, actor: BoardActor, scope?: Scope) =>
      await startRun(store, issueId, input, actor, scope),
    attachRunExecution: async (runId: string, input: AttachRunExecutionInput, scope?: Scope) =>
      await attachRunExecution(store, runId, input, scope),
    recordRunSessionRef: async (runId: string, ref: string, scope?: Scope) =>
      await recordRunSessionRef(store, runId, ref, scope),
    clearRunSessionRef: async (runId: string, actor: BoardActor, options?: { replaceWith?: string }, scope?: Scope) =>
      await clearRunSessionRef(store, runId, actor, options, scope),
    finishRun: async (runId: string, input: FinishRunInput, actor: BoardActor, scope?: Scope) =>
      await finishRun(store, runId, input, actor, scope),
    stopRunningRuns: async (issueId: string, actor: BoardActor, scope?: Scope) =>
      await stopRunningRuns(store, issueId, actor, scope),
    listRuns: async (issueId: string) => await listRuns(store, issueId),
    findRunByChatSessionId: async (chatSessionId: string) => await findRunByChatSessionId(store, chatSessionId),
    readBoardProjection: async (workspaceId: string) => await readBoardProjection(store, workspaceId),
    readBoardProjectionForIssues: async (issueIds: string[]) => await readBoardProjectionForIssues(store, issueIds),
    readBoardProjectionForIssue: async (issueId: string) => await readBoardProjectionForIssue(store, issueId),

    // The board as a whole
    listReady: async (input: { workspaceId: string, limit?: number }) => await listReady(store, input),
    queryReady: async (input: { workspaceId: string, limit?: number, offset?: number }) => await queryReady(store, input),
    buildPrimeText: async (workspaceId: string) => await buildPrimeText(store, workspaceId),
  }
}

/** The board's operations, as a type callers can name. */
export type BoardOps = ReturnType<typeof createBoardOps<BoardStore>>

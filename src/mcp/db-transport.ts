import { openBoardSession, requireCard, requireRun } from '../cli/command'
import { sessionRefFromEnvironment } from '../domain/external-session-ref'
import { toIssueView } from '../domain/issue-view'
import type { CardQueryResult } from '../ops/card-query'
import type { BoardActor } from '../ops/types'
import type { Issue } from '../sqlite/schema'
import type { KanboCardPage, KanboCardQuery, KanboCardResult, KanboColumnResult, KanboReadyPage, KanboToolTransport } from './transport'
import {
  DEFAULT_KANBO_CARD_INCLUDES,
  DEFAULT_KANBO_COMMENT_LIMIT,
  projectKanboCard,
  projectKanboCardComment,
  projectKanboColumn,
  projectKanboFieldChange,
  projectKanboPullRequest,
  projectKanboRun,
  projectKanboSprint,
  projectKanboSubCard,
} from './transport'

/**
 * The board's tools, run against the board itself.
 *
 * This is the transport `kanbo mcp` serves: an agent working in a checkout
 * with no server running still drives its card, because the board — a
 * file or a database of its own — and the operations that give it meaning ship
 * with this package. Everything a `kanbo` command decides is decided here too,
 * by calling the same code: which board, which workspace, which card a
 * reference names, and the refusal to write to one this build cannot speak for.
 */

/** Where the board is, whose board it is, and who the writes are filed under. */
export interface KanboDbTransportInput {
  /** The board file to open; resolved the way every `kanbo` command resolves it when absent. */
  dbPath?: string
  /** The external board to open instead; resolved the same way when absent. */
  databaseUrl?: string
  /** The workspace to work on; resolved from the binding or the working directory when absent. */
  workspaceId?: string
  /**
   * Who every write is filed under. Never taken from a tool argument: an agent
   * that could name its own kind could name `user`, and the one rule the board
   * has about people would be worth nothing.
   */
  actor: BoardActor
}

/** The transport, and the board it holds open. */
export interface KanboDbTransport extends KanboToolTransport {
  /** Let go of the board. The server that holds this transport closes it. */
  close: () => Promise<void>
}

export async function createDbTransport(input: KanboDbTransportInput): Promise<KanboDbTransport> {
  // Opened for reading: a board file older than this build is still worth
  // looking at, and every write below asks the same guard a `kanbo` command
  // asks. A client talks to this server for as long as it likes, and the board
  // may be migrated underneath it in the meantime.
  const session = await openBoardSession(
    { db: input.dbPath, databaseUrl: input.databaseUrl, workspace: input.workspaceId, asAgent: true },
    'read',
  )
  const { ops, store, workspace } = session
  const workspaceId = workspace.id
  const actor = input.actor

  async function readColumns(): Promise<KanboColumnResult[]> {
    return (await ops.listColumns(workspaceId)).map(projectKanboColumn)
  }

  /** One card with what the run registry says about it, in the shape a tool prints. */
  async function project(card: Issue, columns?: KanboColumnResult[]): Promise<KanboCardResult> {
    const runs = await ops.readBoardProjectionForIssue(card.id)
    return projectKanboCard({ ...toIssueView(card), ...runs }, columns ?? await readColumns())
  }

  /** The cards a query picks, filtered and cut into a page by the database, with their run facts. */
  async function cardPage({ columns: named, parent, priority, ...query }: KanboCardQuery): Promise<KanboCardPage> {
    const parentCard = parent === undefined ? null : await resolveCard(parent)
    const page = await ops.queryCards({
      ...query,
      workspaceId,
      columns: named,
      parentIssueId: parentCard?.id,
      priorities: priority,
    })
    return { cards: await projectPage(page), total: page.total, offset: query.offset ?? 0 }
  }

  async function readyPage({ returnedLimit, ...input }: { limit?: number, offset?: number, returnedLimit?: number }): Promise<KanboReadyPage> {
    const page = await ops.queryReady({ workspaceId, ...input })
    // A ready card waits for no one, and one a person returned is listed under `returned`.
    const ready = { cards: await projectPage(page, { attend: false }), total: page.total, offset: input.offset ?? 0 }
    return returnedLimit === undefined
      ? ready
      : { ...ready, returned: await cardPage({ returned: true, limit: returnedLimit }) }
  }

  /**
   * A page's cards as a tool prints them: the columns came with the page, the
   * run facts are one more statement, and which cards were returned and what
   * the waiting and returned ones last said at most two more.
   */
  async function projectPage(page: CardQueryResult, { attend = true } = {}): Promise<KanboCardResult[]> {
    const columns = page.columns.map(projectKanboColumn)
    const runs = await ops.readBoardProjectionForIssues(page.cards.map(card => card.id))
    const attention = attend ? await ops.readCardAttention(page.cards, runs.map(run => run.activeRun !== null)) : []
    return page.cards.map((card, index) => projectKanboCard(
      { ...toIssueView(card), ...runs[index]!, attention: attention[index] },
      columns,
    ))
  }

  /** The card a tool named: the key, the key without its padding, or the number. */
  async function resolveCard(reference: string): Promise<Issue> {
    return await requireCard(session, reference)
  }

  return {
    close: session.close,

    prime: async () => ({ text: await ops.buildPrimeText(workspaceId) }),

    ready: async ({ limit }) => (await readyPage({ limit })).cards,

    readyPage,

    columns: readColumns,

    sprints: async () => (await ops.listSprints(workspaceId)).map(projectKanboSprint),

    cardGet: async ({ card, include = DEFAULT_KANBO_CARD_INCLUDES, commentLimit = DEFAULT_KANBO_COMMENT_LIMIT }) => {
      const found = await resolveCard(card)
      const wants = new Set(include)
      const [columns, runs, subCards, comments, runList, history, pullRequests] = await Promise.all([
        readColumns(),
        ops.readBoardProjectionForIssue(found.id),
        wants.has('subCards') ? store.issues.listPage({ workspaceId: found.workspaceId, parentIssueId: found.id }) : null,
        wants.has('comments') ? store.comments.listByIssue(found.id) : null,
        wants.has('runs') ? ops.listRuns(found.id) : null,
        wants.has('history') ? store.fieldChanges.listByIssue(found.id) : null,
        wants.has('prs') ? store.pullRequests.listByIssue(found.id) : null,
      ])
      return {
        ...projectKanboCard({ ...toIssueView(found), ...runs }, columns),
        ...(subCards ? { subCards: subCards.cards.map(row => projectKanboSubCard(row, columns)) } : {}),
        ...(comments ? { comments: comments.slice(-commentLimit).map(projectKanboCardComment), commentCount: comments.length } : {}),
        ...(runList ? { runs: runList.map(projectKanboRun) } : {}),
        ...(history ? { history: history.map(projectKanboFieldChange) } : {}),
        ...(pullRequests ? { pullRequests: pullRequests.map(projectKanboPullRequest) } : {}),
      }
    },

    cardList: async ({ column, limit }) => (await cardPage({ columns: column ? [column] : undefined, limit })).cards,

    cardPage,

    cardCreate: async ({ title, description, column, parent, executionMode }) => {
      await session.assertWritable()
      const parentCard = parent ? await resolveCard(parent) : null
      return await project(await ops.createCard({
        workspace,
        title,
        description,
        statusName: column,
        parentIssueId: parentCard?.id,
        executionMode,
      }, actor))
    },

    cardUpdate: async ({ card, parent, ...patch }) => {
      await session.assertWritable()
      const existing = await resolveCard(card)
      // A parent is written only when one was named: an update of the title leaves the card where it is.
      const placement = parent === undefined ? {} : { parentIssueId: parent === null ? null : (await resolveCard(parent)).id }
      return await project(await ops.updateCard(existing.id, { ...patch, ...placement }, actor))
    },

    cardMove: async ({ card, column }) => {
      await session.assertWritable()
      const existing = await resolveCard(card)
      return await project(await ops.moveCard(existing.id, column, actor))
    },

    cardComment: async ({ card, content }) => {
      await session.assertWritable()
      const existing = await resolveCard(card)
      const comment = await ops.addComment({ issueId: existing.id, content }, actor)
      return { id: comment.id, issueId: comment.issueId, content: comment.content, createdAt: comment.createdAt }
    },

    cardLinkPullRequest: async ({ card, url }) => {
      await session.assertWritable()
      const existing = await resolveCard(card)
      return projectKanboPullRequest(await ops.linkPullRequest(existing.id, url, actor))
    },

    cardPullRequests: async ({ card }) => {
      const existing = await resolveCard(card)
      return (await ops.listPullRequests(existing.id)).map(projectKanboPullRequest)
    },

    statusLine: async ({ card, text }) => {
      await session.assertWritable()
      const existing = await resolveCard(card)
      return await project(await ops.setStatusLine(existing.id, text, actor))
    },

    waitApproval: async ({ card, text }) => {
      await session.assertWritable()
      const existing = await resolveCard(card)
      return await project(await ops.waitApproval(existing.id, { statusLine: text }, actor))
    },

    runStart: async ({ card, agent, branch, executionMode, session: externalSessionRef }) => {
      await session.assertWritable()
      const existing = await resolveCard(card)
      // Filed as launched from outside, because it was: no app's chat session
      // started this, and a board that claimed otherwise would send someone
      // looking for a session that never existed.
      return projectKanboRun(await ops.startRun(existing.id, {
        agentName: agent,
        branch,
        executionMode,
        externalSessionRef: externalSessionRef ?? sessionRefFromEnvironment() ?? undefined,
        launchedByKind: 'external',
      }, actor))
    },

    runFinish: async ({ run, state, errorText }) => {
      await session.assertWritable()
      const existing = await requireRun(session, run)
      return projectKanboRun(await ops.finishRun(existing.id, { state, errorText }, actor))
    },
  }
}

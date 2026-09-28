import { openBoardSession, requireCard, requireRun } from '../cli/command'
import { toIssueView } from '../domain/issue-view'
import { requireColumn } from '../ops/columns'
import type { BoardActor } from '../ops/types'
import type { Issue } from '../sqlite/schema'
import type { KanboCardResult, KanboColumnResult, KanboToolTransport } from './transport'
import {
  projectKanboCard,
  projectKanboColumn,
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

  async function projectAll(cards: Issue[]): Promise<KanboCardResult[]> {
    const columns = await readColumns()
    // One entry per card, in the order asked — read by position, not searched
    // for, which on a board of thousands was a scan per card.
    const runs = await ops.readBoardProjectionForIssues(cards.map(card => card.id))
    return cards.map((card, index) => projectKanboCard({ ...toIssueView(card), ...runs[index]! }, columns))
  }

  /** The card a tool named: the key, the key without its padding, or the number. */
  async function resolveCard(reference: string): Promise<Issue> {
    return await requireCard(session, reference)
  }

  return {
    close: session.close,

    prime: async () => ({ text: await ops.buildPrimeText(workspaceId) }),

    ready: async ({ limit }) => await projectAll(await ops.listReady({ workspaceId, limit })),

    columns: readColumns,

    sprints: async () => (await ops.listSprints(workspaceId)).map(projectKanboSprint),

    cardGet: async ({ card }) => {
      const found = await resolveCard(card)
      const columns = await readColumns()
      const subCards = (await store.issues.listInBoardOrder(found.workspaceId))
        .filter(row => row.parentIssueId === found.id)
      return {
        ...await project(found, columns),
        subCards: subCards.map(row => projectKanboSubCard(row, columns)),
      }
    },

    cardList: async ({ column, limit }) => {
      const wanted = column ? await requireColumn(store, workspaceId, column) : null
      const cards = (await store.issues.listInBoardOrder(workspaceId))
        .filter(card => !wanted || card.statusId === wanted.id)
        .slice(0, limit ?? Number.POSITIVE_INFINITY)
      return await projectAll(cards)
    },

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

    cardUpdate: async ({ card, ...patch }) => {
      await session.assertWritable()
      const existing = await resolveCard(card)
      return await project(await ops.updateCard(existing.id, patch, actor))
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
        externalSessionRef,
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

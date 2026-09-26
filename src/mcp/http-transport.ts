import { z } from 'zod'

import { BoardError } from '../domain/errors'
import { normalizeStatusName } from '../domain/status-name'
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
 * The board's tools, run against a server of the board's `/issues` routes over
 * HTTP.
 *
 * This is the transport an app's own MCP server holds, and going
 * through the server rather than the file is the whole point of it: the server
 * is the board's single writing connection, it resolves the calling agent from
 * the session the request carries, it registers the await that wakes a session
 * whose card is waiting for a person, and its board version is what every open
 * host window is watching.
 *
 * How the request is made is the host's: it passes `request`, which is where
 * the server URL, the session header and the error contract live. This package
 * knows only the routes and the shapes that come back.
 */

/** One call to the server. The host owns the URL, the headers and what a failure means. */
export type KanboHttpRequest = (
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: Record<string, unknown>,
) => Promise<unknown>

/** How to reach the server, and which board to ask it about. */
export interface KanboHttpTransportInput {
  request: KanboHttpRequest
  /**
   * The workspace every question is about, asked per call rather than captured:
   * the host learns it when a runtime is launched, which can be after the tools
   * were built.
   */
  workspaceId: () => string
}

const IssueSchema = z.object({
  id: z.string(),
  number: z.number(),
  title: z.string(),
  description: z.string().nullable(),
  statusId: z.string().nullable(),
  statusLine: z.string().nullable(),
  waitingFor: z.literal('human').nullable(),
  priority: z.enum(['none', 'low', 'medium', 'high', 'urgent']),
  labels: z.array(z.string()),
  executionMode: z.enum(['worktree', 'main']),
  parentIssueId: z.string().nullable(),
  updatedAt: z.number(),
  attemptCount: z.number(),
  activeRun: z.object({
    id: z.string(),
    agentName: z.string(),
    state: z.enum(['running', 'finished', 'failed', 'stopped']),
    executionMode: z.enum(['worktree', 'main']),
    branch: z.string().nullable(),
    startedAt: z.number(),
  }).nullable(),
})

const StatusSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  order: z.number(),
  // The column's entry rules, as the row stores them (a JSON array in text) or
  // already read into a list; absent from a server that predates them.
  entryRules: z.union([z.string(), z.array(z.string())]).nullish(),
})

const CommentSchema = z.object({
  id: z.string(),
  issueId: z.string(),
  content: z.string(),
  createdAt: z.number(),
})

const RunSchema = z.object({
  id: z.string(),
  issueId: z.string(),
  agentName: z.string(),
  state: z.enum(['running', 'finished', 'failed', 'stopped']),
  executionMode: z.enum(['worktree', 'main']),
  branch: z.string().nullable(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  // Absent from a server that predates it (ruling 7-1).
  externalSessionRef: z.string().nullish(),
})

const PullRequestSchema = z.object({
  id: z.string(),
  issueId: z.string(),
  owner: z.string(),
  repo: z.string(),
  number: z.number(),
  url: z.string(),
  createdAt: z.number(),
})

const SprintSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(['open', 'closed']),
  startDate: z.number().nullable(),
  dueDate: z.number().nullable(),
  current: z.boolean(),
  cards: z.object({ open: z.number(), done: z.number() }),
})

const PrimeSchema = z.object({ text: z.string() })

export function createHttpTransport(input: KanboHttpTransportInput): KanboToolTransport {
  const { request } = input

  async function readColumns(): Promise<KanboColumnResult[]> {
    const statuses = z.array(StatusSchema).parse(
      await request('GET', `/issues/statuses?workspaceId=${encodeURIComponent(input.workspaceId())}`),
    )
    return statuses.map(projectKanboColumn)
  }

  /**
   * One card as a tool prints it. The response carries the column as a foreign
   * key, so the columns are read alongside it to turn that back into the slug
   * an agent moves a card by.
   */
  async function projectOne(response: unknown): Promise<KanboCardResult> {
    return projectKanboCard(IssueSchema.parse(response), await readColumns())
  }

  /** The column a caller named, by slug or by name, as the id the list route filters on. */
  function requireColumn(columns: KanboColumnResult[], nameOrId: string): KanboColumnResult {
    const slug = normalizeStatusName(nameOrId)
    const column = columns.find(candidate => candidate.id === nameOrId || candidate.slug === slug)
    if (!column) {
      throw new BoardError('issue_status_not_found', { statusName: nameOrId, normalizedStatusName: slug })
    }
    return column
  }

  return {
    prime: async () => PrimeSchema.parse(
      await request('GET', `/issues/prime?workspaceId=${encodeURIComponent(input.workspaceId())}`),
    ),

    ready: async ({ limit }) => {
      const query = new URLSearchParams({ workspaceId: input.workspaceId() })
      if (limit !== undefined) {
        query.set('limit', String(limit))
      }
      const cards = z.array(IssueSchema).parse(await request('GET', `/issues/ready?${query.toString()}`))
      const columns = await readColumns()
      return cards.map(row => projectKanboCard(row, columns))
    },

    columns: readColumns,

    sprints: async () => z.array(SprintSchema).parse(
      await request('GET', `/issues/sprints?workspaceId=${encodeURIComponent(input.workspaceId())}`),
    ).map(projectKanboSprint),

    cardGet: async ({ card }) => {
      const found = IssueSchema.parse(await request('GET', `/issues/${encodeURIComponent(card)}`))
      const columns = await readColumns()
      const query = new URLSearchParams({ workspaceId: input.workspaceId(), parentIssueId: found.id })
      const subCards = z.array(IssueSchema).parse(await request('GET', `/issues/?${query.toString()}`))
      return {
        ...projectKanboCard(found, columns),
        subCards: subCards.map(row => projectKanboSubCard(row, columns)),
      }
    },

    cardList: async ({ column, limit }) => {
      const columns = await readColumns()
      const query = new URLSearchParams({ workspaceId: input.workspaceId() })
      if (column) {
        query.set('statusId', requireColumn(columns, column).id)
      }
      const cards = z.array(IssueSchema).parse(await request('GET', `/issues/?${query.toString()}`))
      return cards.slice(0, limit ?? Number.POSITIVE_INFINITY).map(row => projectKanboCard(row, columns))
    },

    cardCreate: async ({ title, description, column, parent, executionMode }) => await projectOne(
      await request('POST', '/issues/', {
        workspaceId: input.workspaceId(),
        ...(title !== undefined ? { title } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(column !== undefined ? { statusName: column } : {}),
        ...(parent !== undefined ? { parentIssueId: parent } : {}),
        ...(executionMode !== undefined ? { executionMode } : {}),
      }),
    ),

    cardUpdate: async ({ card, ...patch }) => await projectOne(
      await request('PATCH', `/issues/${encodeURIComponent(card)}`, patch),
    ),

    cardMove: async ({ card, column }) => await projectOne(
      await request('PATCH', `/issues/${encodeURIComponent(card)}/status/${encodeURIComponent(column)}`),
    ),

    cardComment: async ({ card, content }) => CommentSchema.parse(
      await request('POST', `/issues/${encodeURIComponent(card)}/comments`, { content }),
    ),

    cardLinkPullRequest: async ({ card, url }) => projectKanboPullRequest(PullRequestSchema.parse(
      await request('POST', `/issues/${encodeURIComponent(card)}/pull-requests`, { url }),
    )),

    cardPullRequests: async ({ card }) => z.array(PullRequestSchema).parse(
      await request('GET', `/issues/${encodeURIComponent(card)}/pull-requests`),
    ).map(projectKanboPullRequest),

    statusLine: async ({ card, text }) => await projectOne(
      await request('PATCH', `/issues/${encodeURIComponent(card)}/status-line`, { statusLine: text }),
    ),

    waitApproval: async ({ card, text }) => await projectOne(
      await request(
        'POST',
        `/issues/${encodeURIComponent(card)}/wait-approval`,
        text === undefined ? {} : { statusLine: text },
      ),
    ),

    runStart: async ({ card, agent, branch, executionMode, session }) => projectKanboRun(RunSchema.parse(
      await request('POST', `/issues/${encodeURIComponent(card)}/runs`, {
        agentName: agent,
        ...(branch !== undefined ? { branch } : {}),
        ...(executionMode !== undefined ? { executionMode } : {}),
        ...(session !== undefined ? { externalSessionRef: session } : {}),
      }),
    )),

    runFinish: async ({ run, state, errorText }) => projectKanboRun(RunSchema.parse(
      await request('PATCH', `/issues/runs/${encodeURIComponent(run)}`, {
        state,
        ...(errorText !== undefined ? { errorText } : {}),
      }),
    )),
  }
}

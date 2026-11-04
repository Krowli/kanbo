import type { IssueActivityItemView } from '../../domain/activity-types'
import type { BoardRunView } from '../../ops/runs'
import type { IssueFieldChange } from '../../sqlite/schema'
import type { ServeErrorBody } from '../errors'
import type { ServeProjectView } from '../projects'
import type { ServeCardView, ServeCommentView, ServeStatusView } from '../views'

/**
 * The `/issues` routes the page calls, on the server that served it. Every
 * request carries the token the person gave, when they gave one; a failure is
 * an `ApiError` with the server's status, code and message.
 */

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

export interface BoardApi {
  /** Every project the server offers; never prefixed. */
  projects: () => Promise<ServeProjectView[]>
  /** The workspace of the project the page is showing. */
  workspace: () => Promise<{ id: string, identifier: string, name: string }>
  version: () => Promise<number>
  statuses: () => Promise<ServeStatusView[]>
  cards: () => Promise<ServeCardView[]>
  createCard: (input: { workspaceId: string, statusId: string, description: string }) => Promise<ServeCardView>
  moveCard: (cardId: string, statusId: string) => Promise<ServeCardView>
  comments: (cardId: string) => Promise<ServeCommentView[]>
  addComment: (cardId: string, content: string) => Promise<ServeCommentView>
  activity: (cardId: string) => Promise<IssueActivityItemView[]>
  runs: (cardId: string) => Promise<BoardRunView[]>
  /** The raw field changes, for the texts of a description change. */
  fieldChanges: (cardId: string) => Promise<IssueFieldChange[]>
  approve: (cardId: string, comment: string | null) => Promise<ServeCardView>
  returnCard: (cardId: string, comment: string) => Promise<ServeCardView>
}

/**
 * `readBase` is the path the current project's `/issues` routes sit under:
 * `''` for the project the server was started in, `/projects/<id>` for another.
 */
export function createBoardApi(readToken: () => string | null, readBase: () => string = () => ''): BoardApi {
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {}
    const token = readToken()
    if (token) {
      headers.authorization = `Bearer ${token}`
    }
    // The server takes a write only as JSON, with a body or without.
    if (method !== 'GET') {
      headers['content-type'] = 'application/json'
    }
    let response: Response
    try {
      response = await fetch(path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    }
    catch {
      // `fetch` rejects only when it got no answer at all.
      throw new ApiError(0, 'server_unreachable', 'The board server has stopped. Run kanbo serve to open it again.')
    }
    const text = await response.text()
    if (!response.ok) {
      const failure = readFailure(text)
      throw new ApiError(response.status, failure?.code ?? 'unknown', failure?.message ?? `${response.status} ${response.statusText}`)
    }
    return JSON.parse(text) as T
  }

  const board = (path: string): string => `${readBase()}${path}`
  const card = (id: string): string => board(`/issues/${encodeURIComponent(id)}`)

  return {
    projects: async () => await request('GET', '/projects'),
    workspace: async () => await request('GET', board('/issues/workspace')),
    version: async () => (await request<{ seq: number }>('GET', board('/issues/version'))).seq,
    statuses: async () => await request('GET', board('/issues/statuses')),
    cards: async () => await request('GET', board('/issues')),
    createCard: async input => await request('POST', board('/issues'), input),
    moveCard: async (cardId, statusId) => await request('PATCH', `${card(cardId)}/status/${encodeURIComponent(statusId)}`),
    comments: async cardId => await request('GET', `${card(cardId)}/comments`),
    addComment: async (cardId, content) => await request('POST', `${card(cardId)}/comments`, { content }),
    activity: async cardId => await request('GET', `${card(cardId)}/activity`),
    runs: async cardId => await request('GET', `${card(cardId)}/runs`),
    fieldChanges: async cardId => await request('GET', `${card(cardId)}/field-changes`),
    approve: async (cardId, comment) => await request('POST', `${card(cardId)}/approve`, { comment }),
    returnCard: async (cardId, comment) => await request('POST', `${card(cardId)}/return`, { comment }),
  }
}

/** The server's `{ code, message }`, when the answer is one. */
function readFailure(text: string): ServeErrorBody | null {
  try {
    return JSON.parse(text) as ServeErrorBody
  }
  catch {
    return null
  }
}

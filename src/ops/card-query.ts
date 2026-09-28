import type { BoardCardQuery, BoardStore } from '../board-store'
import { BoardError } from '../domain/errors'
import { normalizeStatusName } from '../domain/status-name'
import type { Issue, IssueStatus } from '../sqlite/schema'
import { listColumns, matchColumn } from './columns'

/**
 * Cards picked by what they are, not by reading the board and sorting through
 * it: every filter becomes part of one statement, so a question about five
 * cards on a board of ten thousand reads five cards.
 */

/** What `queryCards` takes: the store's query, with columns named the way a person or an agent names them. */
export interface CardQueryInput extends Omit<BoardCardQuery, 'statusIds'> {
  /** Cards in any of these columns, each by id or by any spelling of its name. */
  columns?: readonly string[]
}

/** A page of cards, how many the query picks in all, and the board's columns read on the way. */
export interface CardQueryResult {
  cards: Issue[]
  total: number
  /** The workspace's columns in board order — what a caller needs to name each card's column. */
  columns: IssueStatus[]
}

/** The column that is named, among the ones already read; the error that says there is none. */
export function pickColumn(columns: readonly IssueStatus[], workspaceId: string, nameOrId: string): IssueStatus {
  const column = matchColumn(columns, workspaceId, nameOrId)
  if (!column) {
    throw new BoardError('issue_status_not_found', {
      workspaceId,
      statusName: nameOrId,
      normalizedStatusName: normalizeStatusName(nameOrId),
    })
  }
  return column
}

/** The cards a query picks, one page of them: the columns in one statement, the cards in one more. */
export async function queryCards(store: BoardStore, input: CardQueryInput): Promise<CardQueryResult> {
  const columns = await listColumns(store, input.workspaceId)
  const { columns: named, ...query } = input
  const statusIds = named?.map(nameOrId => pickColumn(columns, input.workspaceId, nameOrId).id)
  const page = await store.issues.listPage({ ...query, statusIds })
  return { ...page, columns }
}

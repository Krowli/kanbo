import type { BoardStore } from '../board-store'
import { normalizeStatusName } from '../domain/status-name'
import type { Issue } from '../sqlite/schema'
import type { CardQueryResult } from './card-query'
import { listColumns } from './columns'

/** The column an agent takes its next card from. */
const READY_COLUMN_SLUG = 'to_do'

/**
 * The cards an agent may pick up right now: spelled out, nobody working on them,
 * nobody's turn but the agent's.
 *
 * "Ready" is deliberately narrow. A card in Backlog is an idea, a card with a
 * run is taken, and a card waiting for a person belongs to that person until
 * they answer. What is left is the queue — in board order, so the card someone
 * dragged to the top is the one an agent asking for work gets.
 */
export async function listReady(
  store: BoardStore,
  input: { workspaceId: string, limit?: number },
): Promise<Issue[]> {
  return (await queryReady(store, input)).cards
}

/**
 * One page of the ready cards, how many are ready in all, and the columns read
 * on the way — the rule above, asked of the database in one statement rather
 * than of every card on the board.
 */
export async function queryReady(
  store: BoardStore,
  input: { workspaceId: string, limit?: number, offset?: number },
): Promise<CardQueryResult> {
  const columns = await listColumns(store, input.workspaceId)
  const column = columns.find(candidate => normalizeStatusName(candidate.name) === READY_COLUMN_SLUG)
  if (!column) {
    return { cards: [], total: 0, columns }
  }
  const page = await store.issues.listPage({
    workspaceId: input.workspaceId,
    statusIds: [column.id],
    waitingForPerson: false,
    hasActiveRun: false,
    limit: input.limit,
    offset: input.offset,
  })
  return { ...page, columns }
}

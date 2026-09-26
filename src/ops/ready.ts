import type { BoardStore } from '../board-store'
import { normalizeStatusName } from '../domain/status-name'
import type { Issue } from '../sqlite/schema'
import { listColumns } from './columns'
import { readBoardProjectionForIssues } from './runs'

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
  const column = (await listColumns(store, input.workspaceId))
    .find(candidate => normalizeStatusName(candidate.name) === READY_COLUMN_SLUG)
  if (!column) {
    return []
  }

  const candidates = (await store.issues.listInBoardOrder(input.workspaceId))
    .filter(card => card.statusId === column.id && card.waitingFor === null)
  const running = new Set((await readBoardProjectionForIssues(store, candidates.map(card => card.id)))
    .filter(projection => projection.activeRun !== null)
    .map(projection => projection.issueId))

  const ready = candidates.filter(card => !running.has(card.id))
  return input.limit === undefined ? ready : ready.slice(0, input.limit)
}

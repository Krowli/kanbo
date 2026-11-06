import type { BoardStore } from '../board-store'
import { currentUnixSeconds } from '../domain/time'
import type { BoardMetrics, BoardMetricsHistory, BoardMetricsInput } from './board-metrics'
import { computeBoardMetrics } from './board-metrics'
import { listColumnEntries } from './column-entries'

/** The comment kind the metrics read: a person's approvals. Returns are moves (R012-7). */
const APPROVAL_KINDS = ['system.approved'] as const

/** `listColumnEntries` from the board's first column change on (drift check, item 3). */
const FROM_THE_FIRST_CHANGE = 0

/**
 * Every row the metrics of these workspaces are computed from: three
 * statements per workspace (columns, milestones, cards) plus three across all
 * of them (column changes through the `(field, created_at)` index, runs,
 * approvals); none per card.
 *
 * The rows are read and the metrics computed in TypeScript rather than in SQL
 * (ruling R012-1): a board is thousands of rows, not millions; percentiles, ISO
 * weeks and a day-by-day replay would otherwise be written once per dialect;
 * and a host whose workspaces live on several boards can put their rows
 * together and compute once.
 */
export async function readBoardMetricsHistory(store: BoardStore, workspaceIds: readonly string[]): Promise<BoardMetricsHistory> {
  const ids = [...new Set(workspaceIds)]
  if (ids.length === 0) {
    return { statuses: [], milestones: [], cards: [], entries: [], runs: [], approvals: [] }
  }
  const perWorkspace = async <T>(read: (workspaceId: string) => Promise<T[]>): Promise<T[]> => (await Promise.all(ids.map(read))).flat()
  // Separate statements, not one snapshot: a card moved between them can have one stretch off until the next read.
  const [statuses, milestones, cards, entries, runs, approvals] = await Promise.all([
    perWorkspace(async id => await store.statuses.listByWorkspace(id)),
    perWorkspace(async id => await store.milestones.listByWorkspace(id)),
    perWorkspace(async id => await store.issues.listByWorkspace(id)),
    listColumnEntries(store, { workspaceIds: ids, since: FROM_THE_FIRST_CHANGE }),
    store.runs.listByWorkspaces(ids),
    store.comments.listByWorkspaces(ids, APPROVAL_KINDS),
  ])
  return { statuses, milestones, cards, entries, runs, approvals }
}

/** How work flows on the board over `input`'s range (`computeBoardMetrics`), read from the store; without cost. */
export async function boardMetrics(store: BoardStore, input: BoardMetricsInput, now: number = currentUnixSeconds()): Promise<BoardMetrics> {
  return computeBoardMetrics(await readBoardMetricsHistory(store, input.workspaceIds), input, now)
}

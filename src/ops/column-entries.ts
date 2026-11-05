import type { BoardStore, BoardWorkspaceFieldChange } from '../board-store'
import type { IssueFieldChange } from '../sqlite/schema'

/** One card entering one column: a move, or a card created in it (`fromStatusId: null`). */
export interface ColumnEntry {
  changeId: string
  issueId: string
  workspaceId: string
  fromStatusId: string | null
  toStatusId: string
  actorKind: IssueFieldChange['actorKind']
  actorId: string | null
  /** Unix seconds. */
  at: number
}

/** Which boards to read, from when (unix seconds, inclusive), and where a page may end. */
export interface ListColumnEntriesInput {
  workspaceIds: string[]
  since: number
  limit?: number
}

/**
 * Every entry into a column on the named boards at or after `since`, in order
 * of `(at, changeId)` — the one signal an app dispatching work on column
 * changes needs. It sees every writer, an outside `kanbo` on the same database
 * included, because it reads the cards' own history.
 *
 * A page never ends inside a second: when `limit` cuts into one, the rest of
 * that second comes too, so a page may be longer than `limit`. A reader keeps
 * its cursor at the last `at` it read after a short page — a write in that
 * second may still commit — and drops the `changeId`s it has seen; after a page
 * of `limit` or more it moves on to the last `at` + 1, which a second holding
 * more entries than `limit` would otherwise never let it pass.
 */
export async function listColumnEntries(store: BoardStore, input: ListColumnEntriesInput): Promise<ColumnEntry[]> {
  const page = await store.fieldChanges.listByFieldSince('statusId', input)
  const rows = input.limit !== undefined && input.limit > 0 && page.length === input.limit
    ? await withWholeLastSecond(store, input, page)
    : page
  return rows.flatMap(toColumnEntry)
}

/** The page with every change of its last second, not only those `limit` let in. */
async function withWholeLastSecond(
  store: BoardStore,
  input: ListColumnEntriesInput,
  page: BoardWorkspaceFieldChange[],
): Promise<BoardWorkspaceFieldChange[]> {
  const last = page.at(-1)!.createdAt
  const lastSecond = await store.fieldChanges.listByFieldSince('statusId', { workspaceIds: input.workspaceIds, since: last, until: last })
  return [...page.filter(change => change.createdAt < last), ...lastSecond]
}

/** A status change as an entry; a change that took the card out of every column enters none. */
function toColumnEntry(change: BoardWorkspaceFieldChange): ColumnEntry[] {
  return change.toValue === null
    ? []
    : [{
        changeId: change.id,
        issueId: change.issueId,
        workspaceId: change.workspaceId,
        fromStatusId: change.fromValue,
        toStatusId: change.toValue,
        actorKind: change.actorKind,
        actorId: change.actorId,
        at: change.createdAt,
      }]
}

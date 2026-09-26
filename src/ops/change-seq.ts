import type { BoardStore } from '../board-store'
import { currentUnixSeconds } from '../domain/time'

/** The `kanban_meta` row every board write bumps. */
const BOARD_CHANGE_KEY = 'board'

/** The row groups of the store — everything it offers except the transaction itself. */
type BoardStoreGroup = Exclude<keyof BoardStore, 'transaction'>

/**
 * Every store method that changes a row, per group.
 *
 * The list is written out rather than derived from a naming rule so that a
 * method added to a group has to be classified by hand: a read that were treated
 * as a write would only bump the counter too often, but a write mistaken for a
 * read would leave readers on a board that silently changed. `satisfies` ties
 * each name to its group, so renaming a store method breaks the build here.
 */
const MUTATING_METHODS = {
  statuses: ['create', 'update', 'delete'],
  milestones: ['create', 'update', 'delete'],
  issues: ['create', 'update', 'updateMany', 'clearMilestoneReferences', 'clearParentReferences', 'clearDelegateReferences', 'delete'],
  comments: ['create', 'createOnce', 'delete'],
  runs: ['create', 'update'],
  relations: ['create', 'delete', 'deleteByIssue'],
  contextRefs: ['replace'],
  fieldChanges: ['create'],
  pullRequests: ['link', 'unlink'],
  meta: ['bumpRevision'],
} satisfies { [TGroup in BoardStoreGroup]: Array<keyof BoardStore[TGroup]> }

/**
 * One board write in progress: the store to work through, and — behind it — the
 * transaction and the change flag the whole write shares.
 *
 * An operation that takes a scope joins the write it belongs to instead of
 * opening one of its own, which is how a card operation that seeds columns, a
 * status line and a comment still counts as a single change.
 */
export interface BoardWriteScope<TStore extends BoardStore = BoardStore> {
  /** The transactional store, wrapped so every write through it is noticed. */
  readonly tx: TStore
}

interface ChangeTracker {
  changed: boolean
}

/**
 * The same store, with every mutating method wrapped so that calling it marks
 * the write as having changed something.
 *
 * Groups the board does not own — the `lookups` a host composes beside it — are
 * carried over untouched, which is why the wrapper is built from the store's own
 * keys rather than from a fixed list. The cast restores the host's store type:
 * every property is either the original or a wrapper with the same signature.
 */
function trackChanges<TStore extends BoardStore>(store: TStore, tracker: ChangeTracker): TStore {
  const wrapped = { ...store } as Record<string, unknown>

  for (const [group, methods] of Object.entries(MUTATING_METHODS)) {
    const source = store[group as BoardStoreGroup] as unknown as Record<string, (...args: unknown[]) => unknown>
    const replacement: Record<string, unknown> = { ...source }
    for (const method of methods) {
      replacement[method] = (...args: unknown[]) => {
        tracker.changed = true
        return source[method](...args)
      }
    }
    wrapped[group] = replacement
  }

  // A transaction opened through the wrapper keeps the callback inside it, so
  // writes made there are noticed too.
  wrapped.transaction = async (fn: (tx: TStore) => Promise<unknown>, options?: { mode?: 'deferred' | 'immediate' }) =>
    await store.transaction(async () => await fn(wrapped as TStore), options)

  return wrapped as TStore
}

/**
 * Run `fn` as one board write: everything it writes commits together, and the
 * board's change counter goes up by exactly one if it wrote anything at all.
 *
 * The counter is what tells a reader — the board UI polling, a CLI, another
 * agent — that the board is not the board it last read. It is bumped from the
 * outermost scope only, after `fn` returns and only when a mutating store method
 * was actually called, so a read-only pass and a transaction that rolls back
 * both leave it untouched. Pass `scope` to join a write that is already open
 * instead of starting a second one.
 *
 * The transaction takes its write lock up front (`immediate`), so two writers
 * racing for the same board file fail fast rather than half-way through. A write
 * that starts while the host already holds a transaction of its own becomes a
 * savepoint inside it — the board counter then commits, or rolls back, with
 * whatever the host is doing.
 *
 * The caller rule of the underlying transaction applies in full: `fn` must be
 * the only database-touching async chain in flight, and inside it only
 * operations that resolve without I/O may be awaited.
 */
export async function runBoardWrite<TStore extends BoardStore, TResult>(
  store: TStore,
  fn: (scope: BoardWriteScope<TStore>) => Promise<TResult>,
  scope?: BoardWriteScope<TStore>,
): Promise<TResult> {
  if (scope) {
    return await fn(scope)
  }

  const tracker: ChangeTracker = { changed: false }
  return await store.transaction(async (tx) => {
    // A host that composes its own groups beside the board — an app's server
    // and its `lookups` — hands its own store to the callback; only the type of
    // `transaction` on the constraint says `BoardStore`.
    const result = await fn({ tx: trackChanges(tx as TStore, tracker) })
    if (tracker.changed) {
      await tx.meta.bumpRevision(BOARD_CHANGE_KEY, currentUnixSeconds())
    }
    return result
  }, { mode: 'immediate' })
}

/**
 * How many times the board has changed. A reader that holds a number and reads
 * the same one back is looking at the board it already has.
 */
export async function readChangeSeq(store: BoardStore): Promise<number> {
  return (await store.meta.read(BOARD_CHANGE_KEY))?.revision ?? 0
}

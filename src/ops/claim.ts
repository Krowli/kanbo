import type { BoardStore } from '../board-store'
import { READY_COLUMN_SLUG } from '../domain/column-templates'
import { BoardError } from '../domain/errors'
import { normalizeStatusName } from '../domain/status-name'
import type { Issue, IssueRun, IssueStatus } from '../sqlite/schema'
import type { BoardCardWrite } from './cards'
import { updateCard } from './cards'
import type { BoardWriteScope } from './change-seq'
import { runBoardWrite } from './change-seq'
import { listColumns } from './columns'
import { queryReady } from './ready'
import type { StartRunInput } from './runs'
import { startRun } from './runs'
import type { BoardActor } from './types'

/** What a claim takes: the board, the card when the claimer names one, and the run it starts. */
export interface ClaimCardInput {
  workspaceId: string
  /** The card to take; the first ready card in To Do, in board order, when absent. */
  issueId?: string
  run: StartRunInput
}

/** What a claim did: the card where it now is, the run it started, and the column it moved to. */
export interface ClaimedCard {
  /** Carries `unmetRules` when a person's claim put it in a column whose rules it does not meet. */
  card: BoardCardWrite
  run: IssueRun
  column: IssueStatus
}

/** Why a named card is not there to take, most telling first. */
export type CardNotReadyReason = 'run_active' | 'waiting_for_person' | 'not_in_to_do'

/**
 * Take a card to work on, in one board write: pick it, start its run, and move
 * it into the board's first `started` column (In Progress on a standard
 * board), its entry and flow rules checked on the way in. Anything refused
 * leaves nothing written.
 *
 * Two claimers never get the same card. On SQLite the write holds the file
 * from its first read (`begin immediate`), so the second claimer reads the
 * board after the first one's commit. On Postgres the picked card's row is
 * locked (`select … for update`): a claimer that waited on the lock finds the
 * card taken, and moves on to the next ready one. The target's row is locked
 * first, always, in the order a move into it locks (column, then card), so a
 * claim and a move never wait on each other in a circle.
 */
export async function claimCard<TStore extends BoardStore>(
  store: TStore,
  input: ClaimCardInput,
  actor: BoardActor,
  scope?: BoardWriteScope<TStore>,
): Promise<ClaimedCard> {
  return await runBoardWrite(store, async ({ tx }) => {
    const columns = await listColumns(tx, input.workspaceId)
    const target = columns.find(column => column.category === 'started')
    if (!target) {
      throw new BoardError('issue_status_not_found', { workspaceId: input.workspaceId, category: 'started' })
    }
    await tx.statuses.lockById(target.id)
    const toDo = columns.find(column => normalizeStatusName(column.name) === READY_COLUMN_SLUG) ?? null
    const card = input.issueId === undefined
      ? await takeFirstReady(tx, input.workspaceId, toDo)
      : await takeNamed(tx, input.workspaceId, input.issueId, toDo)
    const run = await startRun(tx, card.id, input.run, actor, { tx })
    const moved = await updateCard(tx, card.id, { statusId: target.id }, actor, { tx })
    return { card: moved, run, column: target }
  }, scope)
}

/**
 * The first ready card, locked. A card another claimer took while this one
 * waited for its lock is passed over, and the next read no longer lists it; the
 * cards passed over are counted so the loop ends with the list.
 */
async function takeFirstReady(store: BoardStore, workspaceId: string, toDo: IssueStatus | null): Promise<Issue> {
  const passed = new Set<string>()
  for (;;) {
    const { cards } = await queryReady(store, { workspaceId, limit: passed.size + 1 })
    const candidate = cards.find(card => !passed.has(card.id))
    if (!candidate) {
      throw new BoardError('board_nothing_ready', { workspaceId })
    }
    const locked = await store.issues.lockById(candidate.id)
    if (locked && await notReadyReason(store, locked, toDo) === null) {
      return locked
    }
    passed.add(candidate.id)
  }
}

/** The named card, locked, when it is on this board and ready — or why not. */
async function takeNamed(store: BoardStore, workspaceId: string, issueId: string, toDo: IssueStatus | null): Promise<Issue> {
  const card = await store.issues.lockById(issueId)
  if (!card || card.workspaceId !== workspaceId) {
    throw new BoardError('issue_not_found', { issueId })
  }
  const reason = await notReadyReason(store, card, toDo)
  if (reason) {
    throw new BoardError('board_card_not_ready', { issueId, reason })
  }
  return card
}

/** `queryReady`'s rule for one card already read: nobody on it, nobody waited for, in To Do. */
async function notReadyReason(store: BoardStore, card: Issue, toDo: IssueStatus | null): Promise<CardNotReadyReason | null> {
  if ((await store.runs.listRunning(card.id)).length > 0) {
    return 'run_active'
  }
  if (card.waitingFor === 'human') {
    return 'waiting_for_person'
  }
  return toDo !== null && card.statusId === toDo.id ? null : 'not_in_to_do'
}

import type { BoardStore } from '../board-store'
import type { UnmetEntryRule } from '../domain/entry-rules'
import { BoardError } from '../domain/errors'
import { currentUnixSeconds } from '../domain/time'
import type { Issue, issues } from '../sqlite/schema'
import { recordFieldChanges, requireMilestoneInWorkspace } from './cards'
import type { BoardWriteScope } from './change-seq'
import { runBoardWrite } from './change-seq'
import { enforceColumnEntryForCards } from './entry-rules'
import type { BoardActor } from './types'

/** The fields one change can set on many cards at once. */
export interface BulkUpdateCardsInput {
  statusId?: string | null
  priority?: Issue['priority']
  labels?: string[]
  milestoneId?: string | null
  assigneeKind?: string | null
  assigneeId?: string | null
  dueDate?: number | null
}

/** What a bulk change did: how many cards it wrote, and — for a person — which of them entered a column short of its rules. */
export interface BulkUpdateCardsResult {
  updated: number
  unmetRules?: Array<{ issueId: string, unmet: UnmetEntryRule[] }>
}

/** How far apart a reorder, or a move onto another board, spaces the cards it places. */
export const CARD_ORDER_GAP = 1024

/**
 * Apply one change to many cards, in one write, each card's history recording
 * what changed on it.
 *
 * Every card is checked before anything is written: a column or a milestone
 * must belong to each card's own workspace, and the column's door holds for
 * every card at once — an agent moving one card that does not qualify moves
 * none (ruling 6-3). An id the board does not hold is skipped, not refused.
 */
export async function bulkUpdateCards<TStore extends BoardStore>(
  store: TStore,
  issueIds: string[],
  input: BulkUpdateCardsInput,
  actor: BoardActor,
  scope?: BoardWriteScope<TStore>,
): Promise<BulkUpdateCardsResult> {
  if (issueIds.length === 0) {
    return { updated: 0 }
  }
  const uniqueIssueIds = [...new Set(issueIds)]
  const updates: Partial<typeof issues.$inferInsert> = { updatedAt: currentUnixSeconds() }
  if ('statusId' in input) {
    updates.statusId = input.statusId ?? null
  }
  if (input.priority !== undefined) {
    updates.priority = input.priority
  }
  if (input.labels !== undefined) {
    updates.labels = JSON.stringify(input.labels)
  }
  if ('milestoneId' in input) {
    updates.milestoneId = input.milestoneId ?? null
  }
  if ('assigneeKind' in input) {
    updates.assigneeKind = input.assigneeKind ?? null
  }
  if ('assigneeId' in input) {
    updates.assigneeId = input.assigneeId ?? null
  }
  if ('dueDate' in input) {
    updates.dueDate = input.dueDate ?? null
  }

  return await runBoardWrite(store, async ({ tx }) => {
    const cards = await tx.issues.listByIds(uniqueIssueIds)
    for (const card of cards) {
      if (input.statusId != null && !await tx.statuses.findInWorkspace(card.workspaceId, input.statusId)) {
        throw new BoardError('issue_status_not_found', { workspaceId: card.workspaceId, statusId: input.statusId })
      }
      if ('milestoneId' in input) {
        await requireMilestoneInWorkspace(tx, card.workspaceId, input.milestoneId ?? null)
      }
    }
    const unmetRules = input.statusId
      ? await enforceColumnEntryForCards(tx, uniqueIssueIds, input.statusId, actor)
      : []
    for (const card of cards) {
      await recordFieldChanges(tx, card, updates, actor)
    }

    const updated = await tx.issues.updateMany(uniqueIssueIds, updates)
    return unmetRules.length > 0 ? { updated, unmetRules } : { updated }
  }, scope)
}

/**
 * Give the named cards of one workspace their positions in the order named.
 *
 * Positions are spaced by a gap rather than packed, so a card dropped between
 * two others later can take a midpoint without moving its neighbours. The whole
 * order is one write — a drag that half-applied would leave a board no client
 * could reconcile — and a card that is gone or belongs to another workspace is
 * skipped rather than failing the rest of the drop.
 */
export async function reorderCards<TStore extends BoardStore>(
  store: TStore,
  workspaceId: string,
  orderedIds: string[],
  scope?: BoardWriteScope<TStore>,
): Promise<void> {
  await runBoardWrite(store, async ({ tx }) => {
    for (const [index, issueId] of orderedIds.entries()) {
      const card = await tx.issues.findById(issueId)
      if (!card || card.workspaceId !== workspaceId) {
        continue
      }
      await tx.issues.update(issueId, { order: (index + 1) * CARD_ORDER_GAP, updatedAt: currentUnixSeconds() })
    }
  }, scope)
}

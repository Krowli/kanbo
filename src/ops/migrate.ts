import type { BoardStore } from '../board-store'
import { nextIssueNumber, nextIssueOrder } from '../domain/numbering'
import { normalizeStatusName } from '../domain/status-name'
import { currentUnixSeconds } from '../domain/time'
import type { issues, IssueStatus } from '../sqlite/schema'
import { CARD_ORDER_GAP } from './card-batch'
import { numberTakenByAnother, recordFieldChanges } from './cards'
import { runBoardWrite } from './change-seq'
import { BOARD_ACTOR } from './types'

/** Which workspace's cards move where, and how their columns and milestones are matched up. */
export interface MigrateCardsInput {
  sourceId: string
  targetId: string
  /**
   * Both workspaces' columns, in board order. The host reads them from each
   * workspace's own board, which is not always the board the cards are moved on:
   * a preview of a move across two boards reads the target's columns from the
   * target while the cards are still on the source.
   */
  sourceStatuses: IssueStatus[]
  targetStatuses: IssueStatus[]
  /** A source column name → the target column name it becomes, when the names differ. */
  statusMappings?: Record<string, string>
  /** A source milestone title → the target milestone title it becomes, when the titles differ. */
  milestoneMappings?: Record<string, string>
  /** Count what would happen, and write nothing. */
  dryRun?: boolean
}

/** What a move of every card from one workspace to another did — or, for a dry run, would do. */
export interface MigrateCardsResult {
  processed: number
  updated: number
  numbersReassigned: number
  statusesMapped: { from: string, to: string }[]
  milestonesMapped: { from: string, to: string | null }[]
  parentIssuesCleared: number
}

/**
 * Move every card of one workspace to another on this board, in one write.
 *
 * Each source column maps to the target column of the same name (or the name
 * `statusMappings` gives it), and to the target's first column when there is
 * none; each milestone maps by title the same way, and to no milestone when
 * there is none. A card whose number the target already uses takes the next
 * free one, the moved cards go to the end of the target board in their own
 * order, and a parent that is in neither workspace is let go of. Every changed
 * field is recorded in the card's history under the board's own actor.
 *
 * One write, because a half-moved board leaves cards split across both
 * workspaces with renumbering already spent on some of them.
 */
export async function migrateCards(store: BoardStore, input: MigrateCardsInput): Promise<MigrateCardsResult> {
  const { sourceId, targetId } = input
  const targetStatusByName = new Map(input.targetStatuses.map(status => [normalizeStatusName(status.name), status]))
  const defaultTargetStatusId = input.targetStatuses[0]?.id ?? null

  const statusIdMap = new Map<string, string | null>()
  const statusesMapped: MigrateCardsResult['statusesMapped'] = []
  for (const source of input.sourceStatuses) {
    const target = targetStatusByName.get(normalizeStatusName(input.statusMappings?.[source.name] ?? source.name))
    statusIdMap.set(source.id, target ? target.id : defaultTargetStatusId)
    statusesMapped.push({ from: source.name, to: target ? target.name : input.targetStatuses[0]?.name ?? '(none)' })
  }

  const targetMilestoneByTitle = new Map((await store.milestones.listByWorkspace(targetId))
    .map(milestone => [milestone.title.trim().toLowerCase(), milestone]))
  const milestoneIdMap = new Map<string, string | null>()
  const milestonesMapped: MigrateCardsResult['milestonesMapped'] = []
  for (const source of await store.milestones.listByWorkspace(sourceId)) {
    const target = targetMilestoneByTitle.get((input.milestoneMappings?.[source.title] ?? source.title).trim().toLowerCase())
    milestoneIdMap.set(source.id, target ? target.id : null)
    milestonesMapped.push({ from: source.title, to: target ? target.title : null })
  }

  const cards = await store.issues.listByWorkspace(sourceId)
  let numbersReassigned = 0
  let parentIssuesCleared = 0

  if (input.dryRun) {
    for (const card of cards) {
      if (await numberTakenByAnother(store, targetId, card)) {
        numbersReassigned++
      }
      if (card.parentIssueId) {
        const parent = await store.issues.findById(card.parentIssueId)
        if (parent && parent.workspaceId !== sourceId && parent.workspaceId !== targetId) {
          parentIssuesCleared++
        }
      }
    }
    return { processed: cards.length, updated: 0, numbersReassigned, statusesMapped, milestonesMapped, parentIssuesCleared }
  }

  await runBoardWrite(store, async ({ tx }) => {
    let order = await nextIssueOrder(targetId, tx)
    for (const card of cards) {
      const updates: Partial<typeof issues.$inferInsert> = {
        workspaceId: targetId,
        updatedAt: currentUnixSeconds(),
        statusId: card.statusId ? (statusIdMap.get(card.statusId) ?? defaultTargetStatusId) : defaultTargetStatusId,
      }
      if (card.milestoneId) {
        updates.milestoneId = milestoneIdMap.get(card.milestoneId) ?? null
      }
      if (await numberTakenByAnother(tx, targetId, card)) {
        updates.number = await nextIssueNumber(targetId, tx)
        numbersReassigned++
      }
      updates.order = order
      order += CARD_ORDER_GAP
      // A parent moving with the card, or already in the target, stays its parent.
      if (card.parentIssueId) {
        const parent = await tx.issues.findById(card.parentIssueId)
        if (parent && parent.workspaceId !== sourceId && parent.workspaceId !== targetId) {
          updates.parentIssueId = null
          parentIssuesCleared++
        }
      }

      await recordFieldChanges(tx, card, updates, BOARD_ACTOR)
      await tx.issues.update(card.id, updates)
    }
  })

  return { processed: cards.length, updated: cards.length, numbersReassigned, statusesMapped, milestonesMapped, parentIssuesCleared }
}

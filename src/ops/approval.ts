import type { BoardStore } from '../board-store'
import type { IssueComment } from '../sqlite/schema'
import { requireCard } from './types'

/** Where a card stands with the person who has to approve it. */
export interface BoardApproval {
  state: 'none' | 'pending' | 'approved' | 'returned'
  /** When the person decided, in unix seconds; `null` while nobody has. */
  decidedAt: number | null
  /** What the person wrote alongside the decision, if anything. */
  comment: string | null
}

/** The first line of the comment an approval writes; anything after it is the person's own. */
export const APPROVED_COMMENT = 'Approved'

/**
 * Where the card stands with the person who has to approve it: waiting for one,
 * or carrying the last decision a person made — which is what a waiting session
 * compares against its own `since` to learn that the answer has arrived.
 */
export async function readApproval(store: BoardStore, issueId: string): Promise<BoardApproval> {
  const card = await requireCard(store, issueId)
  if (card.waitingFor === 'human') {
    return { state: 'pending', decidedAt: null, comment: null }
  }

  const decision = (await store.comments.listByIssue(issueId))
    .filter(comment => comment.authorKind === 'system.approved' || comment.authorKind === 'system.returned')
    .at(-1)
  if (!decision) {
    return { state: 'none', decidedAt: null, comment: null }
  }

  return {
    state: decision.authorKind === 'system.approved' ? 'approved' : 'returned',
    decidedAt: decision.createdAt,
    comment: humanComment(decision),
  }
}

/** What the person wrote beside a decision, with the board's own wording taken off. */
function humanComment(decision: IssueComment): string | null {
  if (decision.authorKind !== 'system.approved') {
    return decision.content.trim() || null
  }
  const [first, ...rest] = decision.content.split('\n')
  const written = (first === APPROVED_COMMENT ? rest.join('\n') : decision.content).trim()
  return written || null
}

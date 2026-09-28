import type { BoardStore } from '../board-store'
import type { IssueActorKind } from '../domain/issue-view'
import { normalizeCommentAuthorKind } from '../domain/issue-view'
import type { Issue, IssueComment } from '../sqlite/schema'
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

/** How much of a comment a list row carries: enough to know what it asks. */
export const LAST_COMMENT_PREVIEW_LENGTH = 200

/** A card's latest comment, as a list row carries it. */
export interface CardLastComment {
  /** Who wrote it; a person's decision (an approval, a return) is the person's. */
  author: IssueActorKind
  /** Its first `LAST_COMMENT_PREVIEW_LENGTH` characters, `…` where it was cut. */
  text: string
  createdAt: number
}

/** What a list says beside a card whose turn is a person's, or which a person just sent back. */
export interface CardAttention {
  /** A person sent it back and nobody has picked it up again (`BoardCardQuery.returned`). */
  returned: boolean
  /** Its latest comment, for a card waiting for a person or returned; `null` for the rest. */
  lastComment: CardLastComment | null
}

/** Every comment kind but the run bookkeeping (`Run started …`, `Run stopped`), which says nothing a person wrote. */
const SAYING_COMMENT_KINDS = [
  'user',
  'agent',
  'provider-target',
  'system',
  'system.delegated',
  'system.undelegated',
  'system.approved',
  'system.returned',
  'system.pr',
] as const satisfies readonly IssueComment['authorKind'][]

/** Fails the build when the schema gains a comment kind this list does not account for. */
const _everyKindAccountedFor: Exclude<IssueComment['authorKind'], typeof SAYING_COMMENT_KINDS[number] | 'system.run'> extends never ? true : never = true

/**
 * Which of these cards were returned and not picked up again, and the latest
 * comment of each that waits for a person or was returned — in two statements
 * for the whole page, however many cards it holds or which of them wait: the
 * latest decision and the latest comment of every card nobody is working on.
 * `running` says, per card, whether a run is going on on it. The answer is in
 * the order of `cards`.
 */
export async function readCardAttention(
  store: BoardStore,
  cards: readonly Issue[],
  running: readonly boolean[],
): Promise<CardAttention[]> {
  const idle = cards.filter((_, index) => !running[index]).map(card => card.id)
  const [decisions, comments] = await Promise.all([
    store.comments.listLatestByIssues(idle, ['system.approved', 'system.returned']),
    store.comments.listLatestByIssues(idle, SAYING_COMMENT_KINDS),
  ])
  const returned = new Set(decisions.filter(comment => comment.authorKind === 'system.returned').map(comment => comment.issueId))
  const latest = new Map(comments.map(comment => [comment.issueId, comment]))
  return cards.map((card) => {
    const isReturned = card.waitingFor === null && returned.has(card.id)
    const comment = card.waitingFor === 'human' || isReturned ? latest.get(card.id) : undefined
    return { returned: isReturned, lastComment: comment ? previewComment(comment) : null }
  })
}

/** A comment cut down to what a list row carries. */
export function previewComment(comment: Pick<IssueComment, 'authorKind' | 'content' | 'createdAt'>): CardLastComment {
  const text = comment.content.trim()
  return {
    author: comment.authorKind === 'system.returned' || comment.authorKind === 'system.approved'
      ? 'user'
      : normalizeCommentAuthorKind(comment.authorKind),
    text: text.length > LAST_COMMENT_PREVIEW_LENGTH ? `${text.slice(0, LAST_COMMENT_PREVIEW_LENGTH - 1)}…` : text,
    createdAt: comment.createdAt,
  }
}

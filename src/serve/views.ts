import type { BoardRunProjection } from '../board-store'
import type { IssueCommentAuthorView } from '../domain/activity-types'
import type { EntryRule, UnmetEntryRule } from '../domain/entry-rules'
import { readEntryRules } from '../domain/entry-rules'
import { commentAuthorReference } from '../domain/issue-activity'
import type { IssueActorReference, IssueView } from '../domain/issue-view'
import { isOutsideWriter, toIssueView } from '../domain/issue-view'
import type { BoardWorkspaceIdentity } from '../domain/numbering'
import type { BoardOps } from '../ops'
import type { IssueActivityResolver } from '../ops/activity'
import type { BoardCardWrite } from '../ops/cards'
import type { Issue, IssueComment, IssueStatus } from '../sqlite/schema'

/**
 * The board's rows in the shapes the `/issues` routes answer with.
 *
 * Every shape here is built out of the package's own projections —
 * `toIssueView` and the run projection for a card, `readEntryRules` for a
 * column, `commentAuthorReference` for who wrote a comment — so an app serving
 * the same routes builds the same shapes, and a client written against one
 * reads the other unchanged. Where such an app fills in something only it
 * knows (an agent's name and avatar, a workspace's name), this server says the
 * id it holds instead.
 */

/**
 * A card as the routes answer it: its row, decoded, with the run facts merged
 * in — how many times it has been launched and the run going on right now —
 * and, after a write that put it in a column whose entry rules it does not
 * meet, what it is missing.
 */
export type ServeCardView = IssueView & Omit<BoardRunProjection, 'issueId'> & { unmetRules?: UnmetEntryRule[] }

/** A column, its entry rules read out of the stored JSON into a list. */
export type ServeStatusView = Omit<IssueStatus, 'entryRules'> & { entryRules: EntryRule[] }

/** A comment, with who wrote it as a reader sees them. */
export type ServeCommentView = IssueComment & { author: IssueCommentAuthorView }

/** Cards with their run facts, read in one projection for all of them; a card with no runs is `0` and `null`. */
export async function toCardViews(ops: BoardOps, cards: Issue[]): Promise<ServeCardView[]> {
  const projections = new Map(
    (await ops.readBoardProjectionForIssues(cards.map(card => card.id))).map(projection => [projection.issueId, projection]),
  )
  return cards.map(card => ({
    ...toIssueView(card),
    attemptCount: projections.get(card.id)?.attemptCount ?? 0,
    activeRun: projections.get(card.id)?.activeRun ?? null,
  }))
}

/** One card, the same way. */
export async function toCardView(ops: BoardOps, card: Issue): Promise<ServeCardView> {
  return (await toCardViews(ops, [card]))[0]
}

/** A card a write just placed, carrying `unmetRules` only when the write reported some. */
export async function toWrittenCardView(ops: BoardOps, card: BoardCardWrite): Promise<ServeCardView> {
  const { unmetRules, ...row } = card
  const view = await toCardView(ops, row)
  return unmetRules ? { ...view, unmetRules } : view
}

export function toStatusView(status: IssueStatus): ServeStatusView {
  return { ...status, entryRules: readEntryRules(status) }
}

export function toCommentView(comment: IssueComment): ServeCommentView {
  return { ...comment, author: resolveActor(commentAuthorReference(comment)) }
}

/**
 * Who a reader sees beside a row, from what the row holds and nothing else.
 *
 * For the kinds that need nobody else's tables: an outside writer is shown
 * under the name it gave, the board writing for itself is `kanbo`, and a person
 * is `You`. An agent and a provider target are rows of whatever app launched
 * them, which this server cannot read, so they are shown by the id the board
 * holds for them.
 */
function resolveActor(actor: IssueActorReference): IssueCommentAuthorView {
  if (actor.kind === 'system') {
    const provenance = { authorId: actor.id, sourceChatSessionId: actor.sourceChatSessionId }
    if (isOutsideWriter(provenance)) {
      return { kind: 'system', id: provenance.authorId, displayName: provenance.authorId, avatarUrl: null, label: 'External' }
    }
    return { kind: 'system', id: null, displayName: 'kanbo', avatarUrl: null, label: 'System' }
  }
  if (actor.kind === 'agent') {
    return { kind: 'agent', id: actor.id, displayName: actor.id ?? 'Unknown agent', avatarUrl: null, label: null }
  }
  if (actor.kind === 'provider-target') {
    return { kind: 'provider-target', id: actor.id, displayName: actor.id ?? 'Unknown provider', avatarUrl: null, label: null }
  }
  return { kind: 'user', id: actor.id ?? '__self__', displayName: 'You', avatarUrl: null, label: null }
}

/**
 * What an Activity feed is read through here: the one workspace this server
 * serves, named by its identity; actors as `resolveActor` reads them; and an
 * agent assignee by its id.
 */
export function createActivityResolver(workspace: BoardWorkspaceIdentity): IssueActivityResolver {
  return {
    workspaceById: new Map([[workspace.id, { id: workspace.id, name: workspace.name }]]),
    resolveActor: async actor => resolveActor(actor),
    resolveAgentName: async agentId => agentId,
  }
}

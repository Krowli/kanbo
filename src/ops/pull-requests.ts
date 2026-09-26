import { randomUUID } from 'node:crypto'

import type { BoardStore } from '../board-store'
import { BoardError } from '../domain/errors'
import { pullRequestFactKeys } from '../domain/pull-request-fact-keys'
import { parsePullRequestRef } from '../domain/pull-request-ref'
import { currentUnixSeconds } from '../domain/time'
import type { IssuePullRequest } from '../sqlite/schema'
import type { BoardWriteScope } from './change-seq'
import { runBoardWrite } from './change-seq'
import type { BoardActor } from './types'
import { BOARD_ACTOR, requireCard, toStoredActorKind } from './types'

/**
 * Name a pull request on a card (ruling 4-1).
 *
 * `urlOrRef` is a GitHub pull request URL or `owner/repo#number`, and anything
 * else is refused before the board is touched. Naming one the card already
 * names hands back the standing link and writes nothing — so the board version
 * moves only when a link was really made. No comment is written: what the pull
 * request *is* — opened, merged, green — is a fact the watcher reads off GitHub
 * and writes itself.
 */
export async function linkPullRequest<TStore extends BoardStore>(
  store: TStore,
  issueId: string,
  urlOrRef: string,
  actor: BoardActor,
  scope?: BoardWriteScope<TStore>,
): Promise<IssuePullRequest> {
  const ref = parsePullRequestRef(urlOrRef)
  return await runBoardWrite(store, async ({ tx }) => {
    await requireCard(tx, issueId)
    const standing = (await tx.pullRequests.listByIssue(issueId))
      .find(link => link.owner === ref.owner && link.repo === ref.repo && link.number === ref.number)
    if (standing) {
      return standing
    }
    return await tx.pullRequests.link({
      id: randomUUID(),
      issueId,
      owner: ref.owner,
      repo: ref.repo,
      number: ref.number,
      url: ref.url,
      createdByKind: toStoredActorKind(actor),
      createdById: actor.id ?? null,
      createdAt: currentUnixSeconds(),
    })
  }, scope)
}

/**
 * Drop one pull request link off a card. A link the card does not name is
 * `board_pull_request_not_found`.
 *
 * Who may drop it depends on who linked it. A person, and the board writing
 * for itself (`BOARD_ACTOR` — the watcher's own "PR is gone" unlink), may drop
 * any link. Every other actor — an agent, a provider target, or anything
 * outside with an identity of its own — may only drop a link its own
 * stored kind and id created; naming another actor's link is
 * `board_pull_request_not_yours`, the same 403 an agent gets for a card it may
 * not approve.
 */
export async function unlinkPullRequest<TStore extends BoardStore>(
  store: TStore,
  issueId: string,
  linkId: string,
  actor: BoardActor,
  scope?: BoardWriteScope<TStore>,
): Promise<IssuePullRequest> {
  return await runBoardWrite(store, async ({ tx }) => {
    await requireCard(tx, issueId)
    const named = (await tx.pullRequests.listByIssue(issueId)).find(link => link.id === linkId)
    if (!named) {
      throw new BoardError('board_pull_request_not_found', { issueId, linkId })
    }
    if (!canUnlinkPullRequest(actor, named)) {
      throw new BoardError('board_pull_request_not_yours', { issueId, linkId })
    }
    const removed = await tx.pullRequests.unlink(issueId, linkId)
    if (!removed) {
      throw new BoardError('board_pull_request_not_found', { issueId, linkId })
    }
    return removed
  }, scope)
}

/** Whether `actor` may drop `link` — see `unlinkPullRequest`. */
function canUnlinkPullRequest(actor: BoardActor, link: IssuePullRequest): boolean {
  if (actor.kind === 'user') {
    return true
  }
  if (actor.kind === BOARD_ACTOR.kind && actor.id === BOARD_ACTOR.id) {
    return true
  }
  return link.createdByKind === toStoredActorKind(actor) && link.createdById === actor.id
}

/** The pull requests a card names, in the order they were linked. */
export async function listPullRequests(store: BoardStore, issueId: string): Promise<IssuePullRequest[]> {
  await requireCard(store, issueId)
  return await store.pullRequests.listByIssue(issueId)
}

/**
 * A pull request a card names, with where it stands as the card's own facts
 * say (ruling 4-7): `merged` or `closed` once the watcher has written that,
 * `open` once it has written «opened», `unknown` before it has read GitHub at
 * all; `ci` is the newest CI verdict written for it, whatever head it was for.
 */
export type BoardPullRequestStanding = IssuePullRequest & {
  state: 'open' | 'merged' | 'closed' | 'unknown'
  ci: 'green' | 'red' | null
}

/**
 * The pull requests a card names, in the order they were linked, each with
 * where it stands — read off the dedupe keys of the facts the watcher wrote on
 * the card, not the text of its comments, and nothing asked of GitHub.
 */
export async function listPullRequestStandings(store: BoardStore, issueId: string): Promise<BoardPullRequestStanding[]> {
  const listed: BoardPullRequestStanding[] = []
  for (const link of await listPullRequests(store, issueId)) {
    listed.push({ ...link, ...await readPullRequestStanding(store, link) })
  }
  return listed
}

/** Three indexed reads for the state and one prefix listing for the newest CI verdict, whose key ends in `:green` or `:red`. */
async function readPullRequestStanding(
  store: BoardStore,
  link: IssuePullRequest,
): Promise<Pick<BoardPullRequestStanding, 'state' | 'ci'>> {
  const keys = pullRequestFactKeys(link)
  const carries = async (key: string): Promise<boolean> => (await store.comments.findByDedupeKey(link.issueId, key)) !== null
  const state = await carries(keys.merged)
    ? 'merged'
    : await carries(keys.closed) ? 'closed' : await carries(keys.opened) ? 'open' : 'unknown'
  const newest = (await store.comments.listByDedupeKeyPrefix(link.issueId, keys.ciPrefix)).at(-1)?.dedupeKey
  const ci = newest?.endsWith(':green') ? 'green' : newest?.endsWith(':red') ? 'red' : null
  return { state, ci }
}

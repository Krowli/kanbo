import type { BoardStore } from '../board-store'
import type { EntryRule, EntryRuleFacts, UnmetEntryRule } from '../domain/entry-rules'
import { evaluateEntryRules, readEntryRules } from '../domain/entry-rules'
import { BoardError } from '../domain/errors'
import { pullRequestFactKeys } from '../domain/pull-request-fact-keys'
import type { IssueStatus } from '../sqlite/schema'
import { readApproval } from './approval'
import type { BoardActor } from './types'

/**
 * A card about to enter a column: its id — `null` while it is still being
 * created — and its description as it will be once the write lands.
 */
export interface EnteringCard {
  id: string | null
  description: string | null
}

/**
 * The column's entry rules the card does not meet (ruling 6-2). A column with
 * no rules answers at once, without reading anything; otherwise only the facts
 * the column's rules need are read.
 */
async function checkColumnEntry(
  store: BoardStore,
  card: EnteringCard,
  column: IssueStatus,
): Promise<UnmetEntryRule[]> {
  const rules = readEntryRules(column)
  if (rules.length === 0) {
    return []
  }
  return evaluateEntryRules(card, rules, await readEntryRuleFacts(store, card.id, rules)).unmet
}

/**
 * Hold a card at the door of a column that asks for more than it has (ruling
 * 6-3). Anyone but a person — or a person's own terminal, `placesForPerson`
 * (ruling 6-6) — is refused with `board_column_rules_unmet`, which
 * names the column and every unmet rule; a person is let through, and the
 * unmet rules come back so the caller can warn them.
 */
export async function enforceColumnEntry(
  store: BoardStore,
  card: EnteringCard,
  column: IssueStatus,
  actor: BoardActor,
): Promise<UnmetEntryRule[]> {
  const unmet = await checkColumnEntry(store, card, column)
  if (unmet.length > 0 && actor.kind !== 'user' && !actor.placesForPerson) {
    throw new BoardError('board_column_rules_unmet', {
      issueId: card.id,
      column: column.name,
      statusId: column.id,
      unmet,
    })
  }
  return unmet
}

/**
 * The same door for several cards entering one column at once — a bulk status
 * change. All or nothing: the first card an agent may not move refuses the
 * whole change. A person gets back the cards that entered with rules unmet.
 */
export async function enforceColumnEntryForCards(
  store: BoardStore,
  issueIds: string[],
  statusId: string,
  actor: BoardActor,
): Promise<Array<{ issueId: string, unmet: UnmetEntryRule[] }>> {
  const column = await store.statuses.findById(statusId)
  if (!column) {
    throw new BoardError('issue_status_not_found', { statusId })
  }
  const entered: Array<{ issueId: string, unmet: UnmetEntryRule[] }> = []
  for (const card of await store.issues.listByIds(issueIds)) {
    if (card.statusId === column.id) {
      continue
    }
    const unmet = await enforceColumnEntry(store, card, column, actor)
    if (unmet.length > 0) {
      entered.push({ issueId: card.id, unmet })
    }
  }
  return entered
}

/**
 * What the rules need to know beyond the card's description. A card still
 * being created has no pull request, no CI verdict and no decision yet.
 */
async function readEntryRuleFacts(store: BoardStore, issueId: string | null, rules: EntryRule[]): Promise<EntryRuleFacts> {
  if (issueId === null) {
    return { pullRequestCount: 0, latestCi: null, approval: 'none' }
  }
  const links = rules.includes('pull_request_linked') || rules.includes('ci_green')
    ? await store.pullRequests.listByIssue(issueId)
    : []
  return {
    pullRequestCount: links.length,
    latestCi: rules.includes('ci_green') ? await readLatestCi(store, issueId, links) : null,
    approval: rules.includes('approved') ? (await readApproval(store, issueId)).state : 'none',
  }
}

/**
 * The newest CI verdict across the card's linked pull requests, read off the
 * facts' dedupe keys: `ci:<owner>/<repo>#<number>@<sha>:green|red`, the
 * spelling a pull request watcher writes. A verdict about a commit that is not one
 * of the card's linked pull requests does not count.
 */
async function readLatestCi(
  store: BoardStore,
  issueId: string,
  links: Array<{ owner: string, repo: string, number: number }>,
): Promise<'green' | 'red' | null> {
  if (links.length === 0) {
    return null
  }
  const prefixes = links.map(link => pullRequestFactKeys(link).ciPrefix)
  const newest = (await store.comments.listByDedupeKeyPrefix(issueId, 'ci:'))
    .filter(comment => prefixes.some(prefix => comment.dedupeKey?.startsWith(prefix)))
    .at(-1)
    ?.dedupeKey
  if (newest?.endsWith(':green')) {
    return 'green'
  }
  return newest?.endsWith(':red') ? 'red' : null
}

import type { BoardStore } from '../board-store'
import type { EntryRule, EntryRuleFacts, UnmetEntryRule } from '../domain/entry-rules'
import { evaluateEntryRules, readEntryRules } from '../domain/entry-rules'
import { BoardError } from '../domain/errors'
import type { ColumnFlowRules, FlowRuleFacts } from '../domain/flow-rules'
import { evaluateFlowRules, readFlowRules } from '../domain/flow-rules'
import { pullRequestFactKeys } from '../domain/pull-request-fact-keys'
import type { IssueStatus } from '../sqlite/schema'
import { readApproval } from './approval'
import type { BoardActor } from './types'

/**
 * A card about to enter a column: its id — `null` while it is still being
 * created —, its description as it will be once the write lands, and the
 * column it comes from (`null` for a card being created).
 */
export interface EnteringCard {
  id: string | null
  description: string | null
  statusId: string | null
}

/**
 * The column's entry rules and flow rules the card does not meet, entry rules
 * first (ruling 6-2; board-workflow spec, Part 2). A column with no rules
 * answers at once, without reading anything; otherwise only the facts its
 * rules need are read. `entering` counts the cards this same write already let
 * into the column, so a bulk move is held to the WIP limit as a whole.
 */
async function checkColumnEntry(
  store: BoardStore,
  card: EnteringCard,
  column: IssueStatus,
  entering: number,
): Promise<UnmetEntryRule[]> {
  const rules = readEntryRules(column)
  const unmet = rules.length === 0 ? [] : evaluateEntryRules(card, rules, await readEntryRuleFacts(store, card.id, rules)).unmet
  const flow = readFlowRules(column)
  if (flow.allowedFrom === null && flow.wipLimit === null) {
    return unmet
  }
  return [...unmet, ...evaluateFlowRules(card, column, flow, await readFlowRuleFacts(store, column, flow, entering))]
}

/** What the flow rules need: the board's column names when the column names where cards come from, and its card count when it has a limit. */
async function readFlowRuleFacts(store: BoardStore, column: IssueStatus, flow: ColumnFlowRules, entering: number): Promise<FlowRuleFacts> {
  const columnNames = flow.allowedFrom === null
    ? new Map<string, string>()
    : new Map((await store.statuses.listByWorkspace(column.workspaceId)).map(other => [other.id, other.name]))
  if (flow.wipLimit === null) {
    return { columnNames, cardsInColumn: 0 }
  }
  // On Postgres the row lock makes every other write putting a card in this
  // column wait until this one ends, so two of them never both take its last
  // place. A SQLite write already holds the file.
  await store.statuses.lockById(column.id)
  const inColumn = await store.issues.listPage({ workspaceId: column.workspaceId, statusIds: [column.id], limit: 1 })
  return { columnNames, cardsInColumn: inColumn.total + entering }
}

/**
 * Hold a card at the door of a column that asks for more than it has — entry
 * rules (ruling 6-3), or flow rules: a column it may not come from, or a column
 * that is full. Anyone but a person — or a person's own terminal,
 * `placesForPerson` (ruling 6-6) — is refused with `board_column_rules_unmet`,
 * which names the column and everything unmet; a person is let through, and
 * the unmet list comes back so the caller can warn them.
 */
export async function enforceColumnEntry(
  store: BoardStore,
  card: EnteringCard,
  column: IssueStatus,
  actor: BoardActor,
  entering = 0,
): Promise<UnmetEntryRule[]> {
  const unmet = await checkColumnEntry(store, card, column, entering)
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
 * Each card counts against the column's WIP limit as the cards before it in the same change entered it.
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
  let entering = 0
  for (const card of await store.issues.listByIds(issueIds)) {
    if (card.statusId === column.id) {
      continue
    }
    const unmet = await enforceColumnEntry(store, card, column, actor, entering)
    entering++
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

import { z } from 'zod'

import { cardDisplayTitle } from '../domain/card-display-title'
import type { KanboCardPage, KanboCardResult } from './transport'

/**
 * How the list tools print cards: small by default, because an agent reads
 * every character of the answer.
 *
 * A compact card is what an agent choosing among cards needs — which card,
 * what it is called, where it is, what it is doing, whose turn it is — and
 * leaves out what it would only read after choosing one: the description,
 * the labels, the priority. A field that is empty is left out rather than
 * printed as `null`. `detail: "full"` prints every field, and `fields` prints
 * the id and the fields named.
 */

/** Every field of a card a list may be asked for by name. */
export const KANBO_CARD_FIELDS = [
  'number',
  'title',
  'description',
  'column',
  'columnSlug',
  'statusLine',
  'waitingFor',
  'priority',
  'labels',
  'executionMode',
  'parentIssueId',
  'attemptCount',
  'activeRun',
  'updatedAt',
] as const satisfies readonly (keyof KanboCardResult)[]

export type KanboCardField = typeof KANBO_CARD_FIELDS[number]

/** How much of each card a list prints. */
export interface KanboCardListView {
  detail?: 'compact' | 'full'
  fields?: readonly KanboCardField[]
}

/** The `detail` and `fields` arguments the list tools share. */
export const cardListViewArguments = {
  detail: z.enum(['compact', 'full']).optional()
    .describe('compact (default): id, title, column slug, status line, waiting, parent, run, updatedAt. full: every field, description included.'),
  fields: z.array(z.enum(KANBO_CARD_FIELDS)).optional()
    .describe('Print the id and only these fields of each card, e.g. ["description"].'),
}

/** A card as a list prints it by default. Empty fields are absent. */
export interface KanboCompactCard {
  id: string
  /** What the card is called — its description's first line when it has no title of its own. */
  title: string
  /** The column's slug, as `kanbo_card_move` takes it. */
  column: string | null
  statusLine?: string
  waitingFor?: 'human'
  parentId?: string
  /** Runs the card has had, when it has had any. */
  attempt?: number
  /** Who is working on the card, and since when; the run's id is in `detail: "full"`. */
  activeRun?: { agentName: string, startedAt: number }
  updatedAt: number
}

export function compactKanboCard(card: KanboCardResult): KanboCompactCard {
  return {
    id: card.id,
    title: cardDisplayTitle(card),
    column: card.columnSlug,
    ...(card.statusLine ? { statusLine: card.statusLine } : {}),
    ...(card.waitingFor ? { waitingFor: card.waitingFor } : {}),
    ...(card.parentIssueId ? { parentId: card.parentIssueId } : {}),
    ...(card.attemptCount > 0 ? { attempt: card.attemptCount } : {}),
    ...(card.activeRun
      ? { activeRun: { agentName: card.activeRun.agentName, startedAt: card.activeRun.startedAt } }
      : {}),
    updatedAt: card.updatedAt,
  }
}

function viewCard(card: KanboCardResult, view: KanboCardListView): object {
  if (view.fields) {
    return Object.fromEntries([['id', card.id], ...view.fields.map(field => [field, card[field]])])
  }
  return view.detail === 'full' ? card : compactKanboCard(card)
}

/**
 * The page as the tool's answer: how many cards the question picks, where the
 * next page starts when there is one, and one card per line.
 */
export function formatKanboCardPage(page: KanboCardPage, view: KanboCardListView): string {
  const shownUntil = page.offset + page.cards.length
  const more = Math.max(0, page.total - shownUntil)
  const head = {
    total: page.total,
    ...(page.offset > 0 ? { offset: page.offset } : {}),
    ...(more > 0 ? { more, nextOffset: shownUntil } : {}),
  }
  const cards = page.cards.map(card => JSON.stringify(viewCard(card, view)))
  const opening = JSON.stringify(head).slice(0, -1)
  return cards.length === 0
    ? `${opening},"cards":[]}`
    : `${opening},"cards":[\n${cards.join(',\n')}\n]}`
}

import { z } from 'zod'

import { cardDisplayTitle } from '../domain/card-display-title'
import type { KanboCardPage, KanboCardResult } from './transport'

/**
 * How the list tools, and the tools that write a card, print cards: small by
 * default, because an agent reads every character of the answer.
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
    .describe('compact (default): id, title, column slug, status line, waiting, parent, run, updatedAt; returned, and the last comment of a waiting or returned card. full: every field, description included.'),
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
  /** A person sent it back, and nobody has picked it up again. */
  returned?: true
  /** For a card waiting for a person or returned: its latest comment, so "what is waiting" is one call. */
  lastComment?: KanboCardResult['lastComment']
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
    ...(card.returned ? { returned: card.returned } : {}),
    ...(card.lastComment ? { lastComment: card.lastComment } : {}),
  }
}

/** The `detail` argument of the tools that write a card: a list's own word, for the one card a write answers with. */
export const writtenCardDetailArgument = z.enum(['compact', 'full']).optional()
  .describe('compact (default): the card as kanbo_card_list prints it. full: every field, description included.')

/** What each tool that writes a card says about its answer, in its description. */
export const WRITTEN_CARD_ANSWER_SENTENCE = 'Answers the card compact, as kanbo_card_list prints it; detail: "full" for every field.'

/**
 * The card a write hands back, as the tool answers with it: compact and on one
 * line, as a list prints it. An agent writes its card at every step — a status
 * line, a move, an update — and reads each answer again on every later turn,
 * so a whole card, description included, would cost it again and again.
 * `detail: "full"` answers every field, as `kanbo_card_get` prints the card alone.
 */
export function formatWrittenKanboCard(card: KanboCardResult, detail?: KanboCardListView['detail']): string {
  return detail === 'full' ? JSON.stringify(card, null, 2) : JSON.stringify(compactKanboCard(card))
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
export function formatKanboCardPage(page: KanboCardPage, view: KanboCardListView, returned?: KanboCardPage): string {
  const shownUntil = page.offset + page.cards.length
  const more = Math.max(0, page.total - shownUntil)
  const head = {
    total: page.total,
    ...(page.offset > 0 ? { offset: page.offset } : {}),
    ...(more > 0 ? { more, nextOffset: shownUntil } : {}),
  }
  const cards = page.cards.map(card => JSON.stringify(viewCard(card, view)))
  // Cards a person sent back come first, before anything new is taken.
  const lead = returned && returned.cards.length > 0
    ? `"returned":[\n${returned.cards.map(card => JSON.stringify(viewCard(card, view))).join(',\n')}\n],${
      returned.total > returned.cards.length ? `"returnedTotal":${returned.total},` : ''}`
    : ''
  const opening = `{${lead}${JSON.stringify(head).slice(1, -1)}`
  return cards.length === 0
    ? `${opening},"cards":[]}`
    : `${opening},"cards":[\n${cards.join(',\n')}\n]}`
}

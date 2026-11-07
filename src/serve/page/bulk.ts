import type { BoardApi, BulkChange } from './api'

/**
 * A change to every selected card, sent as one `PATCH /issues/bulk`: the server
 * checks them all before it writes any, and, for a person, lets a card into a
 * column short of its rules with a warning rather than refusing it. The answer
 * says which cards went in short; a refusal comes back as an error, with
 * nothing written, for the page to show.
 *
 * Returns the one notice to show, or `null` when every card went in clean.
 */
export async function applyBulk(
  api: Pick<BoardApi, 'bulkUpdate'>,
  cardIds: readonly string[],
  change: BulkChange,
  where: { column?: string },
): Promise<string | null> {
  if (cardIds.length === 0) {
    return null
  }
  const result = await api.bulkUpdate(cardIds, change)
  const short = result.unmetRules ?? []
  if (short.length === 0) {
    return null
  }
  const list = short.map(item => `${item.issueId} (${item.unmet.map(rule => rule.detail).join('; ')})`).join('; ')
  const place = where.column ? `in ${where.column}` : 'updated'
  return `${result.updated} ${result.updated === 1 ? 'card is' : 'cards are'} ${place}. Short of its rules: ${list}.`
}

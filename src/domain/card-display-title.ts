/**
 * What a card is called wherever a person or an agent reads it by name.
 *
 * A card written as a description alone is titled with its own key (every
 * writer does that). Named by its key, such a card says nothing — so its name
 * is the first line of its description instead. A browser bundle that does not
 * load this package keeps the same rule on its own, tested with the same
 * examples.
 */

/** How long a description line may run before it is cut with an ellipsis. */
const DESCRIPTION_LINE_LIMIT = 120

export function cardDisplayTitle(card: { id: string, title: string, description?: string | null }): string {
  if (card.title !== card.id) {
    return card.title
  }
  return descriptionFirstLine(card.description) ?? card.title
}

function descriptionFirstLine(description: string | null | undefined): string | null {
  for (const rawLine of (description ?? '').split('\n')) {
    const line = stripMarkdown(rawLine)
    if (line) {
      return line.length > DESCRIPTION_LINE_LIMIT ? `${line.slice(0, DESCRIPTION_LINE_LIMIT - 1).trimEnd()}…` : line
    }
  }
  return null
}

function stripMarkdown(line: string): string {
  return line
    .replace(/^\s*(?:>\s*)+/, '')
    .replace(/^\s*#{1,6}\s+/, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ x]\]\s+)?/i, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

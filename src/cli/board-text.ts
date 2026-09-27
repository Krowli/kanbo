import pc from 'picocolors'

import { cardDisplayTitle } from '../domain/card-display-title'
import { normalizeStatusName } from '../domain/status-name'
import type { IssueStatus } from '../sqlite/schema'
import { displayWidth, sanitizeTerminalText, truncateToWidth } from './terminal-text'
import type { CardView } from './view'

/**
 * The board as `kanbo board` shows it in a terminal: one section per column,
 * in board order, stacked rather than side by side — a narrow terminal or a
 * Windows console reads it as well as a wide one.
 */

/** How many cards a Done or Canceled column shows without `--all`: the most recently changed. */
export const FINISHED_COLUMN_LIMIT = 5

/** One column of the board as `kanbo board` shows it — and prints with `--json`. */
export interface BoardSection {
  /** `null` for the cards that sit in no column. */
  name: string | null
  slug: string | null
  category: IssueStatus['category'] | null
  /** Every card in the column. */
  count: number
  /** The cards shown, in board order: all of them, or the last few of a finished column. */
  cards: CardView[]
}

/** Every field `kanbo board --json` may ask for. */
export const BOARD_SECTION_FIELDS: readonly (keyof BoardSection)[] = ['name', 'slug', 'category', 'count', 'cards']

/**
 * The sections: every column in board order with its cards, the empty
 * Canceled column left out, a Done or Canceled column cut to the cards changed
 * last unless `all`, and the cards in no column at the end when there are any.
 */
export function buildBoardSections(
  columns: IssueStatus[],
  cards: CardView[],
  options: { all: boolean, keepEmptyCanceled?: boolean },
): BoardSection[] {
  const sections: BoardSection[] = []
  for (const column of columns) {
    const inColumn = cards.filter(card => card.column === column.name)
    if (column.category === 'canceled' && inColumn.length === 0 && !options.keepEmptyCanceled) {
      continue
    }
    const finished = column.category === 'completed' || column.category === 'canceled'
    sections.push({
      name: column.name,
      slug: normalizeStatusName(column.name),
      category: column.category,
      count: inColumn.length,
      cards: finished && !options.all ? lastChanged(inColumn, FINISHED_COLUMN_LIMIT) : inColumn,
    })
  }
  const loose = cards.filter(card => card.column === null)
  if (loose.length > 0) {
    sections.push({ name: null, slug: null, category: null, count: loose.length, cards: loose })
  }
  return sections
}

/** The `limit` cards changed last, still in board order. */
function lastChanged(cards: CardView[], limit: number): CardView[] {
  const kept = new Set([...cards].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit))
  return cards.filter(card => kept.has(card))
}

export interface BoardTextOptions {
  /** Columns of the terminal; lines are cut to fit. */
  width: number
  /** Colour the text (a terminal that shows colour, and nobody said `NO_COLOR`). */
  color: boolean
  /** Who a waiting card waits for: `you`, or `a person` in an agent's shell. */
  whom: string
}

/**
 * The board as lines of text:
 *
 * ```
 * In Progress (2)
 *   WST-003  Add a dark theme  [running: claude]
 *            writing the toggle
 *   WST-004  Fix the login form  [waiting for you]
 * ```
 */
export function describeBoardSections(sections: BoardSection[], options: BoardTextOptions): string {
  if (sections.length === 0) {
    return 'This board has no columns yet'
  }
  const colors = pc.createColors(options.color)
  // One column short of the edge: a line that fills the last column wraps on some consoles (Windows).
  const usable = options.width - 1
  const keyWidth = Math.max(0, ...sections.flatMap(section => section.cards.map(card => card.id.length)))

  return sections.map((section) => {
    const heading = `${sanitizeTerminalText(section.name ?? 'No column')} (${section.count})`
    const lines = [colors.bold(truncateToWidth(heading, usable))]
    if (section.count === 0) {
      lines.push(colors.dim('  no cards'))
    }
    for (const card of section.cards) {
      const prefix = `  ${card.id.padEnd(keyWidth)}  `
      const markers = [
        card.waitingFor === 'human' ? { text: `[waiting for ${options.whom}]`, paint: colors.yellow } : null,
        card.activeRun ? { text: `[running: ${sanitizeTerminalText(card.activeRun.agentName)}]`, paint: colors.cyan } : null,
      ].filter(marker => marker !== null)
      const markerText = markers.length > 0 ? `  ${markers.map(marker => marker.text).join(' ')}` : ''
      const room = Math.max(10, usable - displayWidth(prefix) - displayWidth(markerText))
      const painted = markers.length > 0 ? `  ${markers.map(marker => marker.paint(marker.text)).join(' ')}` : ''
      lines.push(`${prefix}${truncateToWidth(sanitizeTerminalText(cardDisplayTitle(card)), room)}${painted}`)
      if (card.statusLine) {
        const indent = ' '.repeat(prefix.length)
        const statusLine = sanitizeTerminalText(firstLine(card.statusLine))
        lines.push(colors.dim(`${indent}${truncateToWidth(statusLine, Math.max(10, usable - indent.length))}`))
      }
    }
    const hidden = section.count - section.cards.length
    if (hidden > 0) {
      lines.push(colors.dim(`  … ${hidden} more — kanbo board --all`))
    }
    return lines.join('\n')
  }).join('\n\n')
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? ''
}

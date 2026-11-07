import type { SubtaskMode } from './subtasks'

/**
 * How the board is shown, apart from which cards: kept in the address, like
 * the filters, so a reload shows the same. Absent means the default.
 */
export interface Display {
  /** `inside`: a sub-task is a row in its parent's card. `cards`: it is a card of its own. */
  subtasks: SubtaskMode
  /** Columns side by side, or one list grouped by column. */
  view: 'board' | 'list'
}

export const DEFAULT_DISPLAY: Display = { subtasks: 'inside', view: 'board' }

export function readDisplay(search: string): Display {
  const params = new URLSearchParams(search)
  return { subtasks: params.get('subtasks') === 'cards' ? 'cards' : 'inside', view: params.get('view') === 'list' ? 'list' : 'board' }
}

/** The query string with the display params set (the default left out) and every other param kept. */
export function writeDisplay(display: Display, search: string): string {
  const params = new URLSearchParams(search)
  if (display.subtasks === 'cards') {
    params.set('subtasks', 'cards')
  }
  else {
    params.delete('subtasks')
  }
  if (display.view === 'list') {
    params.set('view', 'list')
  }
  else {
    params.delete('view')
  }
  const written = params.toString()
  return written ? `?${written}` : ''
}

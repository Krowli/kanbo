import type { SubtaskMode } from './subtasks'

/**
 * How the board is shown, apart from which cards: kept in the address, like
 * the filters, so a reload shows the same. Absent means the default.
 */
export interface Display {
  /** `inside`: a sub-task is a row in its parent's card. `cards`: it is a card of its own. */
  subtasks: SubtaskMode
  /** Columns side by side, one list grouped by column, or the board's metrics. */
  view: 'board' | 'list' | 'analytics'
  /** Analytics: how many weeks back, the current one included. A sprint replaces it. */
  range: 4 | 12 | 26
  /** Analytics: a sprint's id, read over its own dates. */
  sprint: string | null
}

export const DEFAULT_DISPLAY: Display = { subtasks: 'inside', view: 'board', range: 12, sprint: null }

export function readDisplay(search: string): Display {
  const params = new URLSearchParams(search)
  const view = params.get('view')
  const range = Number(params.get('range'))
  return {
    subtasks: params.get('subtasks') === 'cards' ? 'cards' : 'inside',
    view: view === 'list' || view === 'analytics' ? view : 'board',
    range: range === 4 || range === 26 ? range : 12,
    sprint: params.get('sprint') || null,
  }
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
  if (display.view === 'board') {
    params.delete('view')
  }
  else {
    params.set('view', display.view)
  }
  // The range and the sprint belong to Analytics: they are in the address only there.
  if (display.view === 'analytics' && display.range !== 12) {
    params.set('range', String(display.range))
  }
  else {
    params.delete('range')
  }
  if (display.view === 'analytics' && display.sprint !== null) {
    params.set('sprint', display.sprint)
  }
  else {
    params.delete('sprint')
  }
  const written = params.toString()
  return written ? `?${written}` : ''
}

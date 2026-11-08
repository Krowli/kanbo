import type { ServeCardView } from '../views'
import { cardDisplayTitle } from '../../domain/card-display-title'
import { el } from './dom'
import { cardWorker } from './filters'
import { clockIcon, priorityIcon, statusIcon } from './icons'
import { labelTone } from './labels'
import type { SubtaskRow, SubtaskSummary } from './subtasks'

/**
 * The small pieces a card, a list row and the dialog share: the amber pill,
 * the run dot, the worker's avatar, the label chips, the priority and the
 * progress bar. Everything the board holds is set as text.
 */

export const PRIORITY_WORDS: Record<ServeCardView['priority'], string> = { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low', none: 'None' }

/** "Waiting for you" in amber, with a clock; `text` says something else (a sub-task waiting) in the same pill. */
export function waitingPill(text = 'Waiting for you', compact = false): HTMLElement {
  const pill = el('span', compact ? 'waiting-pill waiting-pill--compact' : 'waiting-pill')
  pill.append(clockIcon(), text)
  return pill
}

/** The blue dot of a run that is going; decoration, the words are on its owner. */
export function runDot(): HTMLElement {
  const dot = el('span', 'run-dot')
  dot.setAttribute('aria-hidden', 'true')
  return dot
}

export function isRunning(card: ServeCardView): boolean {
  return card.activeRun?.state === 'running'
}

/**
 * Who works the card: an 18 px circle with an initial for you, a blue square
 * for an agent, and a dot at its corner while a run is live (`running`, which
 * may also be true for a card whose sub-task runs). `null` when nobody works
 * it and nothing runs.
 */
export function avatar(card: ServeCardView, running: boolean): HTMLElement | null {
  const worker = cardWorker(card)
  if (!worker && !running) {
    return null
  }
  const label = worker?.label ?? 'Agent'
  const chip = el('span', 'avatar', label.charAt(0).toUpperCase())
  chip.dataset.kind = worker?.key === 'user' ? 'user' : 'agent'
  const words = running ? `${worker ? label : 'An agent'} is running` : label
  chip.title = running && card.activeRun?.agentName ? `Running · ${card.activeRun.agentName}` : words
  chip.setAttribute('role', 'img')
  chip.setAttribute('aria-label', chip.title)
  if (running) {
    chip.dataset.running = ''
    chip.append(runDot())
  }
  return chip
}

export function labelChip(label: string): HTMLElement {
  const chip = el('span', 'label', label)
  chip.dataset.tone = labelTone(label)
  return chip
}

/** Up to `max` label chips, then "+n" for the rest (its title lists them). */
export function labelChips(labels: readonly string[], max = 2): HTMLElement[] {
  const chips = labels.slice(0, max).map(labelChip)
  if (labels.length > max) {
    const more = el('span', 'label-more', `+${labels.length - max}`)
    more.title = labels.slice(max).join(', ')
    chips.push(more)
  }
  return chips
}

/** The priority's icon and its word, or `null` for none. */
export function priorityTag(priority: ServeCardView['priority']): HTMLElement | null {
  if (priority === 'none') {
    return null
  }
  const tag = el('span', 'priority')
  tag.dataset.priority = priority
  tag.append(priorityIcon(priority), el('span', 'priority-word', PRIORITY_WORDS[priority]))
  return tag
}

/** `2/3 done`, and the same in words for a tooltip. */
export function doneText(summary: SubtaskSummary): { short: string, words: string } {
  return { short: `${summary.done}/${summary.total} done`, words: `${summary.done} of ${summary.total} sub-tasks done` }
}

/** A 4 px bar and "1/3 done" beside it. */
export function progressBar(summary: SubtaskSummary): HTMLElement {
  const { short, words } = doneText(summary)
  const wrap = el('div', 'progress')
  const bar = el('progress', 'progress-bar')
  bar.max = summary.total
  bar.value = summary.done
  bar.setAttribute('aria-label', words)
  const text = el('span', 'progress-text', short)
  text.title = words
  wrap.append(bar, text)
  return wrap
}

/**
 * One sub-task as a 28 px row: its column's status icon, key, title, and on
 * the right a "Waiting" pill, a run dot, and "n/m" for sub-tasks of its own.
 * The click opens that sub-task alone, not the card the row sits in. A row
 * drags onto another column, and a card folded one level deeper is a row with
 * a `data-depth` of 2 or more.
 */
export function subtaskRow(row: SubtaskRow, onOpen: (cardId: string) => void): HTMLElement {
  const item = el('li')
  const button = el('button', 'subtask-row')
  button.type = 'button'
  button.dataset.subtaskId = row.card.id
  button.dataset.depth = String(row.depth)
  button.draggable = true
  button.toggleAttribute('data-dim', row.faded)
  const title = cardDisplayTitle(row.card)
  button.title = `${row.card.id} · ${title}`
  button.append(statusIcon(row.category), el('span', 'card-key', row.card.id), el('span', 'row-title', title))
  const end = el('span', 'row-end')
  if (row.attention) {
    end.append(waitingPill('Waiting', true))
  }
  if (isRunning(row.card)) {
    end.append(runDot())
  }
  if (row.own) {
    end.append(el('span', 'row-count', `${row.own.done}/${row.own.total}`))
  }
  button.append(end)
  button.addEventListener('click', (event) => {
    event.stopPropagation()
    onOpen(row.card.id)
  })
  item.append(button)
  return item
}

/**
 * The checkbox that picks a card for a change of several. It keeps its place in
 * the row but is only seen on hover, focus or once checked (the stylesheet
 * does that); the page reads its clicks by delegation, not here.
 */
export function selectBox(cardId: string): HTMLInputElement {
  const box = el('input', 'select-box')
  box.type = 'checkbox'
  box.setAttribute('aria-label', `Select ${cardId}`)
  return box
}

import { cardDisplayTitle } from '../../domain/card-display-title'
import type { ServeCardView, ServeStatusView } from '../views'
import { el } from './dom'
import { cardWorker } from './filters'

/** What a card's coloured edge says, the first match winning: it waits for you, an agent is running it, it is done, canceled, or none of these. */
type CardState = 'waiting' | 'running' | 'done' | 'quiet' | 'idle'

function cardState(card: ServeCardView, category: ServeStatusView['category'] | null): CardState {
  if (card.waitingFor === 'human') {
    return 'waiting'
  }
  if (card.activeRun?.state === 'running') {
    return 'running'
  }
  if (category === 'completed') {
    return 'done'
  }
  return category === 'canceled' ? 'quiet' : 'idle'
}

/**
 * One card on the board, read top to bottom in the order a person needs it:
 * its state (the "Waiting for you" badge, or "Running · <agent>" beside a
 * pulsing dot, and the `×N` attempt chip once a card has been launched more
 * than once); the display title; the key and who works it; the status line;
 * the priority and labels. `data-state` gives the card its coloured edge.
 * Everything the board holds is set as text.
 *
 * The title is a button stretched over the whole card, so the card opens from
 * the keyboard and is still one thing to drag.
 */
export function renderCard(
  card: ServeCardView,
  category: ServeStatusView['category'] | null,
  onOpen: (card: ServeCardView) => void,
): HTMLElement {
  const element = el('article', 'card')
  element.draggable = true
  element.dataset.cardId = card.id
  element.dataset.state = cardState(card, category)

  const waiting = card.waitingFor === 'human'
  const run = card.activeRun?.state === 'running' ? card.activeRun : null
  const attempts = card.attemptCount > 1
  if (waiting || run || attempts) {
    const state = el('div', 'card-state')
    if (waiting) {
      state.append(el('span', 'waiting-badge', 'Waiting for you'))
    }
    if (run) {
      const running = el('span', 'run-state')
      const dot = el('span', 'run-dot')
      dot.setAttribute('aria-hidden', 'true')
      running.append(dot, run.agentName ? `Running · ${run.agentName}` : 'Running')
      state.append(running)
    }
    if (attempts) {
      const chip = el('span', 'attempt-chip', `×${card.attemptCount}`)
      chip.title = `Attempt ${card.attemptCount}`
      state.append(chip)
    }
    element.append(state)
  }

  const title = el('button', 'card-title', cardDisplayTitle(card))
  title.type = 'button'
  title.addEventListener('click', () => onOpen(card))
  element.append(title)

  const meta = el('div', 'card-meta')
  meta.append(el('span', 'card-key', card.id))
  const worker = cardWorker(card)
  // While it runs, "Running · <agent>" above already says who works it.
  if (worker && !run?.agentName) {
    const chip = el('span', 'worker', worker.label)
    chip.dataset.kind = worker.key === 'user' ? 'user' : 'agent'
    meta.append(chip)
  }
  element.append(meta)

  const statusLine = card.statusLine?.trim() ?? ''
  if (statusLine) {
    const line = el('p', 'status-line', statusLine)
    line.title = statusLine
    line.dataset.category = category ?? 'unstarted'
    element.append(line)
  }

  if (card.priority !== 'none' || card.labels.length > 0) {
    const tags = el('div', 'card-tags')
    if (card.priority !== 'none') {
      const priority = el('span', 'priority', card.priority)
      priority.dataset.priority = card.priority
      tags.append(priority)
    }
    tags.append(...card.labels.map(label => el('span', 'label', label)))
    element.append(tags)
  }
  return element
}

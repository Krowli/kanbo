import { cardDisplayTitle } from '../../domain/card-display-title'
import type { ServeCardView, ServeStatusView } from '../views'
import { el } from './dom'

/**
 * One card on the board: the key and, while a
 * run is going, a pulsing dot; the display title; then the status line behind
 * a thin rule in the column's colour, the amber "Waiting for you" badge and the
 * `×N` attempt chip once a card has been launched more than once.
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

  const head = el('div', 'card-head')
  head.append(el('span', 'card-key', card.id))
  if (card.activeRun?.state === 'running') {
    const dot = el('span', 'run-dot')
    dot.title = `Running: ${card.activeRun.agentName}`
    dot.setAttribute('role', 'img')
    dot.setAttribute('aria-label', dot.title)
    head.append(dot)
  }
  element.append(head)

  const title = el('button', 'card-title', cardDisplayTitle(card))
  title.type = 'button'
  title.addEventListener('click', () => onOpen(card))
  element.append(title)

  const statusLine = card.statusLine?.trim() ?? ''
  const waiting = card.waitingFor === 'human'
  const attempts = card.attemptCount > 1
  if (statusLine || waiting || attempts) {
    const row = el('div', 'card-status')
    if (statusLine) {
      const line = el('p', 'status-line', statusLine)
      line.title = statusLine
      line.dataset.category = category ?? 'unstarted'
      row.append(line)
    }
    if (waiting) {
      row.append(el('span', 'waiting-badge', 'Waiting for you'))
    }
    if (attempts) {
      const chip = el('span', 'attempt-chip', `×${card.attemptCount}`)
      chip.title = `Attempt ${card.attemptCount}`
      row.append(chip)
    }
    element.append(row)
  }
  return element
}

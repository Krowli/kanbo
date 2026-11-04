import { cardDisplayTitle } from '../../domain/card-display-title'
import type { ServeCardView, ServeStatusView } from '../views'
import { el } from './dom'
import { cardWorker } from './filters'
import type { SubcardSummary } from './subcards'

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

/** What a card knows of the cards around it: its parent, its sub-cards' progress, and how to open another card. */
export interface CardContext {
  parent: ServeCardView | null
  summary: SubcardSummary | null
  onOpenCard: (cardId: string) => void
}

/** `2/3 sub-cards`, or `All 3 sub-cards done`; and the same in words for a tooltip. */
export function summaryText(summary: SubcardSummary): { chip: string, words: string } {
  const words = `${summary.done} of ${summary.total} sub-cards done`
  return { chip: summary.done === summary.total ? `All ${summary.total} sub-cards done` : `${summary.done}/${summary.total} sub-cards`, words }
}

/**
 * One card on the board, read top to bottom in the order a person needs it:
 * its state (the "Waiting for you" badge, or "Running · <agent>" beside a
 * pulsing dot, and the `×N` attempt chip once a card has been launched more
 * than once); the display title; the key and who works it; the status line;
 * the priority and labels. `data-state` gives the card its coloured edge.
 * A sub-card also carries a line naming its parent (a button that opens the
 * parent), and a parent a `2/3 sub-cards` chip. Everything the board holds is
 * set as text.
 *
 * The title is a button stretched over the whole card, so the card opens from
 * the keyboard and is still one thing to drag.
 */
export function renderCard(
  card: ServeCardView,
  category: ServeStatusView['category'] | null,
  onOpen: (card: ServeCardView) => void,
  context?: CardContext,
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

  if (context && card.parentIssueId) {
    const parent = context.parent
    const line = parent ? el('button', 'parent-link') : el('span', 'parent-link')
    line.append(el('span', 'parent-arrow', '↳ '), el('span', 'card-key', card.parentIssueId))
    if (parent) {
      const button = line as HTMLButtonElement
      button.type = 'button'
      line.append(el('span', 'parent-title', cardDisplayTitle(parent)))
      line.title = `Parent: ${cardDisplayTitle(parent)}`
      line.addEventListener('click', (event) => {
        event.stopPropagation()
        context.onOpenCard(parent.id)
      })
    }
    element.append(line)
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
  if (context?.summary) {
    const { chip, words } = summaryText(context.summary)
    const progress = el('span', 'subcard-chip', chip)
    progress.title = words
    meta.append(progress)
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

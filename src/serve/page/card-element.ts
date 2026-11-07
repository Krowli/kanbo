import { cardDisplayTitle } from '../../domain/card-display-title'
import type { ServeCardView, ServeStatusView } from '../views'
import { el } from './dom'
import { parentIcon } from './icons'
import { avatar, isRunning, labelChips, priorityTag, progressBar, selectBox, subtaskRow, waitingPill } from './parts'
import type { SubtaskBlock, SubtaskSummary } from './subtasks'

/** What a card's look says, the first match winning: it waits for you, an agent is running it, it is done, canceled, or none of these. */
type CardState = 'waiting' | 'running' | 'done' | 'quiet' | 'idle'

function cardState(card: ServeCardView, category: ServeStatusView['category'] | null): CardState {
  if (card.waitingFor === 'human') {
    return 'waiting'
  }
  if (isRunning(card)) {
    return 'running'
  }
  if (category === 'completed') {
    return 'done'
  }
  return category === 'canceled' ? 'quiet' : 'idle'
}

/** What a card knows of the cards around it: its parent, its sub-tasks' progress, and how to open another card. */
export interface CardContext {
  parent: ServeCardView | null
  summary: SubtaskSummary | null
  onOpenCard: (cardId: string) => void
  /** Inside mode: the sub-task rows this parent draws in itself. Absent in cards mode. */
  block?: SubtaskBlock
  /** A card under this one, at any depth, waits for a person. */
  waitsBelow?: boolean
  /** A card under this one, at any depth, has a run going. */
  runsBelow?: boolean
}

/**
 * The "Sub-task of KEY title" strip a sub-task card wears as its first row: a
 * button that opens the parent, or, for a parent that is not on this board,
 * its key alone.
 */
export function subtaskStrip(card: ServeCardView, context: CardContext): HTMLElement | null {
  if (!card.parentIssueId || card.parentIssueId === card.id) {
    return null
  }
  const parent = context.parent
  const strip = parent ? el('button', 'subtask-strip') : el('span', 'subtask-strip')
  strip.append(parentIcon(), el('span', 'strip-label', 'Sub-task of'), el('span', 'card-key', card.parentIssueId))
  if (parent) {
    const title = cardDisplayTitle(parent)
    const opener = strip as HTMLButtonElement
    opener.type = 'button'
    strip.append(el('span', 'strip-title', title))
    strip.title = `Sub-task of ${parent.id} · ${title}`
    strip.addEventListener('click', (event) => {
      event.stopPropagation()
      context.onOpenCard(parent.id)
    })
  }
  return strip
}

/** The sub-task block under a parent's footer: a row each, "+N more", then the bar. */
function subtaskBlock(block: SubtaskBlock, context: CardContext, open: () => void): HTMLElement {
  const wrap = el('div', 'subtask-block')
  const list = el('ul', 'subtask-list')
  list.append(...block.rows.map(row => subtaskRow(row, context.onOpenCard)))
  wrap.append(list)
  if (block.more > 0) {
    const more = el('button', 'subtask-more', `+${block.more} more`)
    more.type = 'button'
    more.addEventListener('click', open)
    wrap.append(more)
  }
  if (block.summary) {
    wrap.append(progressBar(block.summary))
  }
  return wrap
}

/**
 * One card on the board, read top to bottom in the order a person needs it:
 * the meta row (key, and who works it with a dot while a run is live); the
 * display title; a status row (the status line, "Waiting for you", `×N`
 * attempts); and the footer (priority, labels). A sub-task card opens with a
 * "Sub-task of" strip; a parent closes with its sub-task block (rows and a
 * progress bar), or, when its sub-tasks are cards of their own, the bar alone. Everything the
 * board holds is set as text.
 *
 * The title is a button stretched over the whole card, so the card opens from
 * the keyboard and is still one thing to drag; the controls above it take
 * their own clicks.
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

  if (context) {
    const strip = subtaskStrip(card, context)
    if (strip) {
      element.dataset.subtask = ''
      element.append(strip)
    }
  }

  const meta = el('div', 'card-meta')
  meta.append(selectBox(card.id), el('span', 'card-key', card.id), el('span', 'spacer'))
  const worker = avatar(card, isRunning(card) || context?.runsBelow === true)
  if (worker) {
    meta.append(worker)
  }
  element.append(meta)

  const title = el('button', 'card-title', cardDisplayTitle(card))
  title.type = 'button'
  title.addEventListener('click', () => onOpen(card))
  element.append(title)

  const statusLine = card.statusLine?.trim() ?? ''
  const waiting = card.waitingFor === 'human'
  const attempts = card.attemptCount > 1
  const waitsBelow = context?.waitsBelow === true
  if (statusLine || waiting || waitsBelow || attempts) {
    const status = el('div', 'card-status')
    if (statusLine) {
      const line = el('p', 'status-line', statusLine)
      line.title = statusLine
      line.dataset.category = category ?? 'unstarted'
      status.append(line)
    }
    if (waiting) {
      status.append(waitingPill())
    }
    if (waitsBelow) {
      status.append(waitingPill('Sub-task waiting for you'))
    }
    if (attempts) {
      const chip = el('span', 'attempt-chip', `×${card.attemptCount}`)
      chip.title = `Attempt ${card.attemptCount}`
      status.append(chip)
    }
    element.append(status)
  }

  const priority = priorityTag(card.priority)
  if (priority || card.labels.length > 0) {
    const footer = el('div', 'card-footer')
    if (priority) {
      footer.append(priority)
    }
    footer.append(...labelChips(card.labels))
    element.append(footer)
  }

  if (context?.block) {
    element.append(subtaskBlock(context.block, context, () => onOpen(card)))
  }
  else if (context?.summary) {
    element.append(progressBar(context.summary))
  }
  return element
}

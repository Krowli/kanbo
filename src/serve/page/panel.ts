import type { IssueActivityItemView, IssueActivityValueView } from '../../domain/activity-types'
import { cardDisplayTitle } from '../../domain/card-display-title'
import type { BoardRunView } from '../../ops/runs'
import type { ServeCardView, ServeCommentView, ServeStatusView } from '../views'
import { button, el } from './dom'

/**
 * The side panel a card opens into: everything the board holds about it, read
 * only, and the three things a person does from here — comment, approve,
 * return. The description is plain text as it was written; nothing in it is
 * rendered as Markdown or HTML.
 */

export interface CardDetail {
  card: ServeCardView
  status: ServeStatusView | null
  comments: ServeCommentView[]
  activity: IssueActivityItemView[]
  runs: BoardRunView[]
}

export interface PanelActions {
  close: () => void
  addComment: (content: string) => void
  approve: (comment: string | null) => void
  returnCard: (comment: string) => void
}

export function renderPanel(detail: CardDetail, actions: PanelActions, notice: string | null): HTMLElement {
  const { card, status } = detail
  const panel = el('aside', 'panel')
  panel.setAttribute('aria-label', `Card ${card.id}`)

  const head = el('div', 'panel-head')
  head.append(el('span', 'card-key', card.id), button('Close', 'ghost', actions.close))
  panel.append(head)

  panel.append(el('h2', 'panel-title', cardDisplayTitle(card)))
  const facts = el('p', 'panel-facts', status ? status.name : 'No column')
  if (card.waitingFor === 'human') {
    facts.append(' ', el('span', 'waiting-badge', 'Waiting for you'))
  }
  panel.append(facts)
  if (card.statusLine?.trim()) {
    const line = el('p', 'status-line', card.statusLine.trim())
    line.dataset.category = status?.category ?? 'unstarted'
    panel.append(line)
  }
  // Always there, so a refusal can be said without rebuilding the panel and
  // losing the note that was being written.
  const message = el('p', 'panel-notice', notice ?? '')
  message.setAttribute('role', 'alert')
  message.hidden = !notice
  panel.append(message)

  panel.append(section('Description', card.description?.trim()
    ? el('div', 'description', card.description)
    : el('p', 'empty', 'No description.')))

  panel.append(renderDecision(card, actions))
  panel.append(section('Comments', ...renderComments(detail.comments), renderCommentForm(actions)))
  panel.append(section('Activity', renderList(detail.activity, item => [describeActivity(item), item.createdAt], 'No activity.')))
  panel.append(section('Runs', renderList(detail.runs, run => [describeRun(run), run.startedAt], 'No runs.')))
  return panel
}

function section(title: string, ...children: HTMLElement[]): HTMLElement {
  const element = el('section', 'panel-section')
  element.append(el('h3', undefined, title), ...children)
  return element
}

/** Approve (only while the card waits for a person) and Return (only with a reason). */
function renderDecision(card: ServeCardView, actions: PanelActions): HTMLElement {
  const note = el('textarea', 'field')
  note.rows = 2
  note.placeholder = card.waitingFor === 'human' ? 'A note for the agent (needed to return)' : 'Why it goes back (needed to return)'
  note.setAttribute('aria-label', 'Decision note')
  const hint = el('p', 'hint')
  const row = el('div', 'row')
  if (card.waitingFor === 'human') {
    row.append(button('Approve', 'primary', () => actions.approve(note.value.trim() || null)))
  }
  row.append(button('Return', 'secondary', () => {
    const comment = note.value.trim()
    if (!comment) {
      hint.textContent = 'Say why in the note to return the card.'
      note.focus()
      return
    }
    actions.returnCard(comment)
  }))
  return section('Decision', note, row, hint)
}

function renderComments(comments: ServeCommentView[]): HTMLElement[] {
  if (comments.length === 0) {
    return [el('p', 'empty', 'No comments.')]
  }
  const list = el('ul', 'entries')
  for (const comment of comments) {
    const item = el('li')
    const meta = el('div', 'entry-meta')
    meta.append(el('span', 'entry-author', comment.author.displayName), el('span', undefined, formatTime(comment.createdAt)))
    item.append(meta, el('div', 'entry-text', comment.content))
    list.append(item)
  }
  return [list]
}

function renderCommentForm(actions: PanelActions): HTMLElement {
  const form = el('div', 'comment-form')
  const input = el('textarea', 'field')
  input.rows = 2
  input.placeholder = 'Add a comment'
  input.setAttribute('aria-label', 'New comment')
  form.append(input, button('Comment', 'secondary', () => {
    const content = input.value.trim()
    if (content) {
      actions.addComment(content)
    }
  }))
  return form
}

function renderList<T>(items: T[], describe: (item: T) => [string, number], empty: string): HTMLElement {
  if (items.length === 0) {
    return el('p', 'empty', empty)
  }
  const list = el('ul', 'entries')
  for (const item of items) {
    const [text, time] = describe(item)
    const row = el('li')
    row.append(el('div', 'entry-text', text), el('div', 'entry-meta', formatTime(time)))
    list.append(row)
  }
  return list
}

/** One line of the Activity feed, in words. */
function describeActivity(item: IssueActivityItemView): string {
  const who = item.actor.displayName
  if (item.kind === 'created') {
    return `${who} created the card`
  }
  if (item.kind === 'comment') {
    return `${who}: ${item.comment?.content ?? ''}`
  }
  const change = item.fieldChange
  if (!change) {
    return `${who} changed the card`
  }
  switch (change.action) {
    case 'added-description':
      return `${who} added the description`
    case 'updated-description':
      return `${who} updated the description`
    case 'cleared-description':
      return `${who} cleared the description`
    case 'renamed-issue':
      return `${who} renamed the card to ${describeValue(change.toValue)}`
    case 'changed-field': {
      const from = change.fromValue ? ` from ${describeValue(change.fromValue)}` : ''
      return `${who} changed ${change.field ?? 'a field'}${from} to ${describeValue(change.toValue)}`
    }
  }
}

function describeValue(value: IssueActivityValueView | null): string {
  if (!value) {
    return 'nothing'
  }
  if (value.kind === 'text') {
    return value.text
  }
  if (value.kind === 'date') {
    return new Date(value.timestamp * 1000).toLocaleDateString()
  }
  return value.token === 'current-user' ? 'you' : value.token.replaceAll('-', ' ')
}

function describeRun(run: BoardRunView): string {
  return [`Attempt ${run.attempt}`, run.agentName, run.state, run.branch].filter(Boolean).join(' · ')
}

/** A board timestamp (Unix seconds) as the reader's clock says it. */
function formatTime(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString()
}

import type { IssueActivityItemView } from '../../domain/activity-types'
import { cardDisplayTitle } from '../../domain/card-display-title'
import type { BoardRunView } from '../../ops/runs'
import type { IssueFieldChange } from '../../sqlite/schema'
import type { ServeCardView, ServeCommentView, ServeStatusView } from '../views'
import { button, el } from './dom'
import { cardWorker } from './filters'
import type { HistoryEntry } from './history'
import { groupByDay, relativeDay, relativeTime, toHistory } from './history'

/**
 * The dialog a card opens into: everything the board holds about it, read
 * only, and the three things a person does from here — comment, approve,
 * return. The description is plain text as it was written; nothing in it is
 * rendered as Markdown or HTML.
 */

export type PanelTab = 'comments' | 'history' | 'runs'
const TABS: { tab: PanelTab, label: string }[] = [
  { tab: 'comments', label: 'Comments' },
  { tab: 'history', label: 'History' },
  { tab: 'runs', label: 'Runs' },
]

export interface CardDetail {
  card: ServeCardView
  status: ServeStatusView | null
  comments: ServeCommentView[]
  activity: IssueActivityItemView[]
  fieldChanges: IssueFieldChange[]
  runs: BoardRunView[]
  parent: ServeCardView | null
  children: ServeCardView[]
  statuses: ServeStatusView[]
  tab: PanelTab
}

export interface PanelActions {
  close: () => void
  addComment: (content: string) => void
  approve: (comment: string | null) => void
  returnCard: (comment: string) => void
  openCard: (cardId: string) => void
  selectTab: (tab: PanelTab) => void
}

/** Where the person is reading in `host`'s dialog if it shows `cardId`, else 0. Read before the old dialog leaves the document: a detached element reads 0. */
export function readScroll(host: HTMLElement, cardId: string): number {
  const sameCard = host.querySelector('.panel-head .card-key')?.textContent === cardId
  return sameCard ? host.querySelector<HTMLElement>('.panel-scroll')?.scrollTop ?? 0 : 0
}

export function renderPanel(detail: CardDetail, actions: PanelActions, notice: string | null): HTMLElement {
  const { card, status } = detail
  const panel = el('div', 'panel')
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-modal', 'true')
  const titleId = 'panel-title'
  panel.setAttribute('aria-labelledby', titleId)

  const head = el('div', 'panel-head')
  const close = button('✕', 'icon-button', actions.close)
  close.setAttribute('aria-label', 'Close')
  close.title = 'Close (Esc)'
  head.append(el('span', 'card-key', card.id), el('span', 'spacer'), close)

  const scroll = el('div', 'panel-scroll')
  const top = el('div', 'panel-top')
  const title = el('h2', 'panel-title', cardDisplayTitle(card))
  title.id = titleId
  top.append(title, renderStateRow(card, status))
  const history = toHistory(detail.activity, detail.fieldChanges)
  const now = new Date()
  if (card.statusLine?.trim()) {
    const line = el('p', 'status-line', card.statusLine.trim())
    line.dataset.category = status?.category ?? 'unstarted'
    top.append(line)
  }
  // Always there, so a refusal can be said without rebuilding the panel and
  // losing the note that was being written.
  const message = el('p', 'panel-notice', notice ?? '')
  message.setAttribute('role', 'alert')
  message.hidden = !notice
  top.append(message)

  const main = el('div', 'panel-main')
  main.append(section('Description', card.description?.trim()
    ? el('div', 'description', card.description)
    : el('p', 'empty', 'No description.')))
  if (detail.children.length > 0) {
    main.append(renderSubcards(detail, actions))
  }
  const commentsPanel = [...renderCommentsTab(detail.comments, actions, now)]
  const historyPanel = [renderHistory(history, now)]
  const runsPanel = [renderList(detail.runs, run => [describeRun(run), run.startedAt, run.state], 'No runs.', now)]
  const counts: Record<PanelTab, number> = { comments: detail.comments.length, history: history.length, runs: detail.runs.length }
  const bodies: Record<PanelTab, HTMLElement[]> = { comments: commentsPanel, history: historyPanel, runs: runsPanel }
  main.append(renderTabs(detail.tab, counts, bodies, actions))

  const side = el('div', 'panel-side')
  side.append(renderDecision(card, actions), section('Details', renderFacts(card, detail.parent, detail.runs, actions, history, now)))

  const body = el('div', 'panel-body')
  body.append(main, side)
  scroll.append(top, body)
  panel.append(head, scroll)
  return panel
}

function renderStateRow(card: ServeCardView, status: ServeStatusView | null): HTMLElement {
  const row = el('div', 'state-row')
  row.append(el('span', 'column-pill', status ? status.name : 'No column'))
  if (card.waitingFor === 'human') {
    row.append(el('span', 'waiting-badge', 'Waiting for you'))
  }
  if (card.activeRun?.state === 'running') {
    const running = el('span', 'run-state')
    const dot = el('span', 'run-dot')
    dot.setAttribute('aria-hidden', 'true')
    running.append(dot, card.activeRun.agentName ? `Running · ${card.activeRun.agentName}` : 'Running')
    row.append(running)
  }
  return row
}

function renderTabs(selected: PanelTab, counts: Record<PanelTab, number>, bodies: Record<PanelTab, HTMLElement[]>, actions: PanelActions): HTMLElement {
  const wrapper = el('div', 'tabs-wrap')
  const bar = el('div', 'tabs')
  bar.setAttribute('role', 'tablist')
  const panels: HTMLElement[] = []
  const buttons = new Map<PanelTab, HTMLButtonElement>()
  const bodiesByTab = new Map<PanelTab, HTMLElement>()
  // Switched in place, so a note being written in the composer stays; main only remembers the choice.
  const select = (tab: PanelTab): void => {
    for (const [other, tabButton] of buttons) {
      tabButton.setAttribute('aria-selected', String(other === tab))
      tabButton.tabIndex = other === tab ? 0 : -1
      bodiesByTab.get(other)!.hidden = other !== tab
    }
    actions.selectTab(tab)
  }
  TABS.forEach(({ tab, label }, index) => {
    const button = el('button', 'tab')
    button.type = 'button'
    button.id = `tab-${tab}`
    button.setAttribute('role', 'tab')
    button.setAttribute('aria-selected', String(tab === selected))
    button.setAttribute('aria-controls', `tab-panel-${tab}`)
    button.tabIndex = tab === selected ? 0 : -1
    button.append(label, el('span', 'count', String(counts[tab])))
    button.addEventListener('click', () => select(tab))
    button.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
        return
      }
      event.preventDefault()
      const next = TABS[(index + (event.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length]!.tab
      select(next)
      buttons.get(next)?.focus()
    })
    buttons.set(tab, button)
    bar.append(button)
    const body = el('div', 'tab-panel')
    body.id = `tab-panel-${tab}`
    body.setAttribute('role', 'tabpanel')
    body.setAttribute('aria-labelledby', button.id)
    body.hidden = tab !== selected
    body.append(...bodies[tab])
    bodiesByTab.set(tab, body)
    panels.push(body)
  })
  wrapper.append(bar, ...panels)
  return wrapper
}

/** A board timestamp (Unix seconds) as a `<time>`: `text` on the page, the reader's full date and time on hover. */
function timeElement(seconds: number, text: string): HTMLElement {
  const date = new Date(seconds * 1000)
  const time = el('time', 'history-time', text)
  time.dateTime = date.toISOString()
  time.title = date.toLocaleString()
  return time
}

/** Who made the card, who works it, priority and labels: the answers a person opens a card for. */
function renderFacts(card: ServeCardView, parent: ServeCardView | null, runs: BoardRunView[], actions: PanelActions, history: HistoryEntry[], now: Date): HTMLElement {
  const facts = el('dl', 'facts')
  const row = (term: string, ...value: (HTMLElement | string)[]): void => {
    const detail = el('dd')
    detail.append(...value)
    facts.append(el('dt', undefined, term), detail)
  }

  if (card.parentIssueId) {
    if (parent) {
      const link = el('button', 'link')
      link.type = 'button'
      link.append(el('span', 'card-key', parent.id), el('span', 'link-title', cardDisplayTitle(parent)))
      link.addEventListener('click', () => actions.openCard(parent.id))
      row('Parent', link)
    }
    else {
      row('Parent', el('span', 'card-key', card.parentIssueId))
    }
  }

  const created = history.find(entry => entry.verb === 'created the card')
  const creator = created
    ? { kind: created.actor.kind, name: created.actor.name, label: created.actor.label }
    : { kind: card.createdByKind, name: card.createdByKind === 'user' ? 'You' : card.createdById ?? card.createdByKind, label: null }
  row('Created by', actorChip(creator), ' ', el('span', 'muted', `· ${relativeDay(created?.at ?? card.createdAt, now)}`))

  const worker = cardWorker(card)
  const lastRun = worker ? null : runs.reduce<BoardRunView | null>((latest, run) => (latest === null || run.startedAt > latest.startedAt ? run : latest), null)
  if (lastRun) {
    row('Worked by', actorChip({ kind: 'agent', name: lastRun.agentName, label: null }), ' ', el('span', 'muted', `· ${lastRun.state}`))
  }
  else {
    const workerChip = worker ? actorChip({ kind: worker.key === 'user' ? 'user' : 'agent', name: worker.label, label: null }) : 'Nobody'
    row('Worked by', workerChip, ...(card.activeRun?.state === 'running' ? [' ', el('span', 'muted', '· running')] : []))
  }

  if (card.priority !== 'none') {
    const priority = el('span', 'priority', card.priority)
    priority.dataset.priority = card.priority
    row('Priority', priority)
  }
  if (card.labels.length > 0) {
    row('Labels', ...card.labels.map(label => el('span', 'label', label)))
  }
  return facts
}

/** The parts of this card, each a row that opens it: its column, whether it waits for you or runs, and who works it. */
function renderSubcards(detail: CardDetail, actions: PanelActions): HTMLElement {
  const isDone = (child: ServeCardView): boolean => detail.statuses.find(status => status.id === child.statusId)?.category === 'completed'
  const done = detail.children.filter(isDone).length
  const wrapper = section(`Sub-cards · ${done} of ${detail.children.length} done`)
  const list = el('ul', 'subcards')
  for (const child of detail.children) {
    const item = el('li')
    const row = el('button', 'subcard')
    row.type = 'button'
    row.dataset.done = String(isDone(child))
    row.addEventListener('click', () => actions.openCard(child.id))
    const head = el('span', 'subcard-head')
    head.append(el('span', 'card-key', child.id), el('span', 'subcard-title', cardDisplayTitle(child)))
    const meta = el('span', 'subcard-meta')
    meta.append(el('span', 'subcard-column', detail.statuses.find(status => status.id === child.statusId)?.name ?? 'No column'))
    if (child.waitingFor === 'human') {
      meta.append(el('span', 'waiting-badge', 'Waiting for you'))
    }
    if (child.activeRun?.state === 'running') {
      meta.append(el('span', 'muted', child.activeRun.agentName ? `Running · ${child.activeRun.agentName}` : 'Running'))
    }
    const worker = cardWorker(child)
    if (worker) {
      meta.append(actorChip({ kind: worker.key === 'user' ? 'user' : 'agent', name: worker.label, label: null }))
    }
    row.append(head, meta)
    item.append(row)
    list.append(item)
  }
  wrapper.append(list)
  return wrapper
}

function actorChip(actor: HistoryEntry['actor']): HTMLElement {
  const chip = el('span', 'actor-chip', actor.name)
  // An outside writer here is an agent (or a person's tool) writing under its own name: shown as one, the label kept for the tooltip.
  const outsideWriter = actor.label === 'External'
  chip.dataset.kind = outsideWriter || actor.kind === 'provider-target' ? 'agent' : actor.kind
  if (outsideWriter) {
    chip.title = actor.label ?? ''
  }
  else if (actor.label) {
    chip.append(el('small', 'actor-label', ` ${actor.label}`))
  }
  return chip
}

/** Who changed what and when, a section per day, newest first. */
function renderHistory(history: HistoryEntry[], now: Date): HTMLElement {
  const wrapper = section('History')
  if (history.length === 0) {
    wrapper.append(el('p', 'empty', 'No history yet.'))
    return wrapper
  }
  for (const group of groupByDay(history, now)) {
    const day = el('section', 'history-day')
    day.append(el('h4', undefined, group.day))
    const list = el('ol', 'history-list')
    for (const entry of group.entries) {
      list.append(renderHistoryEntry(entry, now))
    }
    day.append(list)
    wrapper.append(day)
  }
  return wrapper
}

function renderHistoryEntry(entry: HistoryEntry, now: Date): HTMLElement {
  const item = el('li', 'history-entry')
  item.dataset.kind = entry.actor.label === 'External' || entry.actor.kind === 'provider-target' ? 'agent' : entry.actor.kind
  const what = el('span', 'history-what')
  what.append(actorChip(entry.actor), ` ${entry.verb}`)
  if (entry.field) {
    what.append(' ', el('span', 'history-field', entry.field))
  }
  item.append(what, timeElement(entry.at, relativeTime(entry.at, now)))
  if (entry.from !== null || entry.to !== null) {
    const change = el('span', 'history-change')
    if (entry.from !== null) {
      change.append(el('del', 'value-from', entry.from))
    }
    if (entry.to !== null) {
      change.append(el('ins', 'value-to', entry.to))
    }
    item.append(change)
  }
  if (entry.text) {
    const details = el('details', 'history-text')
    details.append(el('summary', undefined, 'Show before / after'))
    const pair = el('div', 'history-text-pair')
    for (const [side, label, value] of [['before', 'Before', entry.text.before], ['after', 'After', entry.text.after]] as const) {
      const block = el('p', 'history-text-block')
      block.dataset.side = side
      block.append(el('b', undefined, label), value ?? '')
      pair.append(block)
    }
    details.append(pair)
    item.append(details)
  }
  return item
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
  const decision = section('Decision', note, row, hint)
  if (card.waitingFor === 'human') {
    decision.dataset.waiting = ''
  }
  return decision
}

/** The composer first, then the comments newest first. */
function renderCommentsTab(comments: ServeCommentView[], actions: PanelActions, now: Date): HTMLElement[] {
  if (comments.length === 0) {
    return [renderCommentForm(actions), el('p', 'empty', 'No comments.')]
  }
  const list = el('ul', 'entries')
  for (const comment of [...comments].reverse()) {
    const item = el('li')
    const meta = el('div', 'entry-meta')
    meta.append(
      actorChip({ kind: comment.author.kind, name: comment.author.displayName, label: comment.author.label }),
      timeElement(comment.createdAt, relativeDay(comment.createdAt, now, { withClock: true })),
    )
    item.append(meta, el('div', 'entry-text', comment.content))
    list.append(item)
  }
  return [renderCommentForm(actions), list]
}

function renderCommentForm(actions: PanelActions): HTMLElement {
  const form = el('div', 'comment-form')
  const input = el('textarea', 'field')
  input.rows = 4
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

function renderList<T>(items: T[], describe: (item: T) => [text: string, time: number, runState: string], empty: string, now: Date): HTMLElement {
  if (items.length === 0) {
    return el('p', 'empty', empty)
  }
  const list = el('ul', 'entries')
  for (const item of items) {
    const [text, time, runState] = describe(item)
    const row = el('li')
    row.dataset.runState = runState
    const meta = el('div', 'entry-meta')
    meta.append(timeElement(time, relativeDay(time, now, { withClock: true })))
    row.append(el('div', 'entry-text', text), meta)
    list.append(row)
  }
  return list
}

function describeRun(run: BoardRunView): string {
  return [`Attempt ${run.attempt}`, run.agentName, run.state, run.branch].filter(Boolean).join(' · ')
}
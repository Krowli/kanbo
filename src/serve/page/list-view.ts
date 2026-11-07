import { cardDisplayTitle } from '../../domain/card-display-title'
import type { ServeCardView, ServeStatusView } from '../views'
import { columnBadge, columnRules } from './column-badges'
import { el } from './dom'
import type { BoardColumn } from './grouping'
import { chevronIcon, lockIcon, parentIcon, priorityIcon, statusIcon } from './icons'
import { avatar, isRunning, labelChips, runDot, selectBox, waitingPill } from './parts'
import type { SubtaskMode } from './subtasks'
import { childrenOf, subtaskSummary } from './subtasks'

/**
 * The List view: a group per column, a row per card. Sub-tasks sit under their
 * parent in `inside` mode (indented, with their own column's icon, even when
 * that column is another group), and are flat rows marked "↰ KEY" in `cards`
 * mode. It builds from the same answers as the board and holds no state: which
 * groups are folded comes in, and a fold goes out.
 */

export interface ListRow {
  card: ServeCardView
  /** 0 for a row in its own column, 1 for a sub-task under its parent. */
  depth: 0 | 1
}

/** The rows of one group: each card, and in `inside` mode its sub-tasks right under it. */
export function listRows(
  groupCards: readonly ServeCardView[],
  cards: readonly ServeCardView[],
  statuses: readonly ServeStatusView[],
  mode: SubtaskMode,
): ListRow[] {
  return groupCards.flatMap((card): ListRow[] => [
    { card, depth: 0 },
    ...(mode === 'inside' ? childrenOf(cards, statuses, card.id).map((child): ListRow => ({ card: child, depth: 1 })) : []),
  ])
}

/** "now", "5m", "3h", "3d", "1mo", "2y": how long ago, in the shortest unit. Times are Unix seconds. */
export function ageText(createdAt: number, now: number): string {
  const seconds = Math.max(0, now - createdAt)
  if (seconds < 60) {
    return 'now'
  }
  const units: [number, string][] = [[365 * 86_400, 'y'], [30 * 86_400, 'mo'], [86_400, 'd'], [3600, 'h'], [60, 'm']]
  const [size, suffix] = units.find(([unit]) => seconds >= unit)!
  return `${Math.floor(seconds / size)}${suffix}`
}

export function collapsedKey(projectKey: string): string {
  return `kanbo:list-collapsed:${projectKey}`
}

/** The ids of the groups folded for a project, kept for the browser session; unreadable means none. */
export function readCollapsed(storage: Pick<Storage, 'getItem'>, projectKey: string): Set<string> {
  try {
    const value: unknown = JSON.parse(storage.getItem(collapsedKey(projectKey)) ?? '[]')
    return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [])
  }
  catch {
    return new Set()
  }
}

export function writeCollapsed(storage: Pick<Storage, 'setItem'>, projectKey: string, collapsed: ReadonlySet<string>): void {
  storage.setItem(collapsedKey(projectKey), JSON.stringify([...collapsed]))
}

export interface ListOptions {
  statuses: readonly ServeStatusView[]
  cards: readonly ServeCardView[]
  /** The groups, with the cards each draws (as the board lays out its columns). */
  groups: readonly BoardColumn[]
  mode: SubtaskMode
  /** Sub-task rows that do not match a filter. */
  faded: ReadonlySet<string>
  collapsed: ReadonlySet<string>
  tally: { shown: ReadonlyMap<string, number>, total: ReadonlyMap<string, number> }
  /** Unix seconds, for each row's age. */
  now: number
  onToggleGroup: (groupId: string) => void
  onOpen: (cardId: string) => void
}

function renderRow(row: ListRow, options: ListOptions): HTMLElement {
  const { card } = row
  const element = el('div', 'list-row')
  element.dataset.cardId = card.id
  element.dataset.depth = String(row.depth)
  element.toggleAttribute('data-dim', options.faded.has(card.id))
  const category = options.statuses.find(status => status.id === card.statusId)?.category ?? null
  element.dataset.state = card.waitingFor === 'human' ? 'waiting' : isRunning(card) ? 'running' : category === 'completed' ? 'done' : category === 'canceled' ? 'quiet' : 'idle'

  const icons = el('span', 'row-icons')
  icons.append(statusIcon(category), priorityIcon(card.priority))
  element.append(selectBox(card.id), icons, el('span', 'card-key', card.id))

  if (row.depth === 0 && options.mode === 'cards' && card.parentIssueId && card.parentIssueId !== card.id) {
    const parent = options.cards.find(candidate => candidate.id === card.parentIssueId)
    const mark = el('span', 'row-parent')
    mark.append(parentIcon(), card.parentIssueId)
    mark.title = parent ? `Sub-task of ${parent.id} · ${cardDisplayTitle(parent)}` : `Sub-task of ${card.parentIssueId}`
    element.append(mark)
  }

  const title = el('button', 'list-title', cardDisplayTitle(card))
  title.type = 'button'
  title.addEventListener('click', () => options.onOpen(card.id))
  element.append(title)

  const marks = el('span', 'row-marks')
  if (card.waitingFor === 'human') {
    marks.append(waitingPill())
  }
  if (isRunning(card)) {
    marks.append(runDot())
  }
  // A sub-task with sub-tasks of its own says how far they are, as its row in the parent's card does.
  const own = row.depth === 1 && options.mode === 'inside' ? subtaskSummary(options.cards, options.statuses, card.id) : null
  if (own) {
    marks.append(el('span', 'row-count', `${own.done}/${own.total}`))
  }
  element.append(marks)

  const meta = el('span', 'row-meta')
  meta.append(...labelChips(card.labels))
  const worker = avatar(card, isRunning(card))
  if (worker) {
    meta.append(worker)
  }
  const age = el('span', 'row-age', ageText(card.createdAt, options.now))
  age.title = new Date(card.createdAt * 1000).toLocaleString()
  meta.append(age)
  element.append(meta)
  return element
}

export function renderList(options: ListOptions): HTMLElement {
  const list = el('div', 'list')
  for (const group of options.groups) {
    const section = el('section', 'list-group')
    section.setAttribute('aria-label', group.name)
    const status = group.status
    const folded = options.collapsed.has(group.id)

    const head = el('div', 'list-group-head')
    const toggle = el('button', 'group-toggle')
    toggle.type = 'button'
    toggle.setAttribute('aria-expanded', String(!folded))
    toggle.setAttribute('aria-label', `${group.name}, ${folded ? 'folded' : 'open'}`)
    toggle.addEventListener('click', () => options.onToggleGroup(group.id))
    toggle.append(chevronIcon())
    const badge = columnBadge(status, status ? options.tally.shown.get(status.id) ?? 0 : group.cards.length, status ? options.tally.total.get(status.id) ?? 0 : group.cards.length)
    const count = el('span', 'group-count', badge.text)
    count.toggleAttribute('data-full', badge.full)
    head.append(toggle, statusIcon(status?.category ?? null), el('span', 'group-name', group.name), count)
    const rules = status ? columnRules(status, options.statuses) : null
    if (rules) {
      const lock = el('span', 'column-lock')
      lock.append(lockIcon())
      lock.title = rules
      lock.setAttribute('role', 'img')
      lock.setAttribute('aria-label', rules.replaceAll('\n', '. '))
      head.append(lock)
    }
    section.append(head)

    if (!folded) {
      const rows = listRows(group.cards, options.cards, options.statuses, options.mode)
      if (rows.length === 0) {
        section.append(el('p', 'list-empty', 'No cards'))
      }
      else {
        section.append(...rows.map(row => renderRow(row, options)))
      }
    }
    list.append(section)
  }
  return list
}

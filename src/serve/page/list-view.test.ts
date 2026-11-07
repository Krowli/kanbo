// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

import type { ServeCardView } from '../views'
import { cardFixture, statusFixture } from './fixtures'
import { groupBoard } from './grouping'
import type { ListOptions } from './list-view'
import { ageText, collapsedKey, listRows, readCollapsed, renderList, writeCollapsed } from './list-view'
import { countByStatus } from './column-badges'
import { drawnCards } from './subtasks'

const statuses = [
  statusFixture({ id: 'todo', name: 'To Do', category: 'unstarted' }),
  statusFixture({ id: 'doing', name: 'Doing', category: 'started', wipLimit: 2 }),
  statusFixture({ id: 'done', name: 'Done', category: 'completed' }),
]
const run: ServeCardView['activeRun'] = { id: 'run', agentId: null, agentName: 'claude', state: 'running', branch: null, executionMode: 'main', chatSessionId: null, startedAt: 0 }
const NOW = 100 * 86_400

function options(cards: ServeCardView[], extra: Partial<ListOptions> = {}): ListOptions {
  const mode = extra.mode ?? 'inside'
  return {
    statuses,
    cards,
    groups: groupBoard(statuses, drawnCards(cards, mode)),
    mode,
    faded: new Set(),
    collapsed: new Set(),
    tally: { shown: countByStatus(cards), total: countByStatus(cards) },
    now: NOW,
    onToggleGroup: () => {},
    onOpen: () => {},
    ...extra,
  }
}

const parent = cardFixture({ id: 'WOR-001', title: 'Ship it', statusId: 'doing' })
const child = cardFixture({ id: 'WOR-002', title: 'Part one', statusId: 'todo', parentIssueId: 'WOR-001' })
const lone = cardFixture({ id: 'WOR-003', title: 'Alone', statusId: 'todo' })

describe('ageText', () => {
  it('says how old a card is in the shortest unit', () => {
    expect(ageText(NOW - 30, NOW)).toBe('now')
    expect(ageText(NOW - 5 * 60, NOW)).toBe('5m')
    expect(ageText(NOW - 3 * 3600, NOW)).toBe('3h')
    expect(ageText(NOW - 3 * 86_400, NOW)).toBe('3d')
    expect(ageText(NOW - 45 * 86_400, NOW)).toBe('1mo')
    expect(ageText(NOW + 10, NOW)).toBe('now')
  })
})

describe('collapsed groups', () => {
  const store = (): Pick<Storage, 'getItem' | 'setItem'> => {
    const data = new Map<string, string>()
    return { getItem: key => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value) }
  }

  it('are kept per project, and an unreadable value means nothing is collapsed', () => {
    const storage = store()
    writeCollapsed(storage, 'p1', new Set(['doing']))
    expect([...readCollapsed(storage, 'p1')]).toEqual(['doing'])
    expect([...readCollapsed(storage, 'p2')]).toEqual([])
    expect(collapsedKey('p1')).not.toBe(collapsedKey('p2'))
    storage.setItem(collapsedKey('p3'), '{not json')
    expect([...readCollapsed(storage, 'p3')]).toEqual([])
  })
})

describe('listRows', () => {
  it('puts a sub-task under its parent, indented, even when it is in another column', () => {
    const cards = [parent, child, lone]
    const groups = groupBoard(statuses, drawnCards(cards, 'inside'))
    const doing = groups.find(group => group.id === 'doing')!
    expect(listRows(doing.cards, cards, statuses, 'inside').map(row => [row.card.id, row.depth])).toEqual([['WOR-001', 0], ['WOR-002', 1]])
    const todo = groups.find(group => group.id === 'todo')!
    expect(listRows(todo.cards, cards, statuses, 'inside').map(row => row.card.id)).toEqual(['WOR-003'])
  })

  it('keeps every row flat in cards mode', () => {
    const cards = [parent, child, lone]
    const todo = groupBoard(statuses, drawnCards(cards, 'cards')).find(group => group.id === 'todo')!
    expect(listRows(todo.cards, cards, statuses, 'cards').map(row => [row.card.id, row.depth])).toEqual([['WOR-002', 0], ['WOR-003', 0]])
  })
})

describe('renderList', () => {
  it('has a header per column with its icon, name and count, and "No cards" for an empty one', () => {
    const list = renderList(options([lone]))
    const heads = [...list.querySelectorAll('.list-group-head')]
    expect(heads.map(head => head.querySelector('.group-name')?.textContent)).toEqual(['To Do', 'Doing', 'Done'])
    expect(heads.map(head => head.querySelector('.group-count')?.textContent)).toEqual(['1', '0/2', '0'])
    expect(heads[0]?.querySelector('.status-icon')).not.toBeNull()
    expect(list.querySelectorAll('.list-empty')).toHaveLength(2)
    expect(list.querySelector('.list-empty')?.textContent).toBe('No cards')
  })

  it('collapses a group from its chevron: the rows go, the header stays, the choice is handed up', () => {
    const onToggleGroup = vi.fn()
    const open = renderList(options([lone], { onToggleGroup }))
    const toggle = open.querySelector<HTMLButtonElement>('.list-group-head button.group-toggle')!
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    toggle.click()
    expect(onToggleGroup).toHaveBeenCalledWith('todo')
    const folded = renderList(options([lone], { collapsed: new Set(['todo']) }))
    expect(folded.querySelector('.list-row')).toBeNull()
    expect(folded.querySelector('.list-group-head button.group-toggle')?.getAttribute('aria-expanded')).toBe('false')
  })

  it('reads a row: status and priority icons, key, title, waiting and run markers, labels, avatar, age', () => {
    const card = cardFixture({ id: 'WOR-003', title: 'Alone', statusId: 'todo', priority: 'high', labels: ['a', 'b', 'c'], waitingFor: 'human', activeRun: run, createdAt: NOW - 3 * 86_400 })
    const row = renderList(options([card])).querySelector<HTMLElement>('.list-row')!
    expect(row.dataset.cardId).toBe('WOR-003')
    expect(row.querySelector('.status-icon')).not.toBeNull()
    expect(row.querySelector('.priority-icon')?.getAttribute('data-priority')).toBe('high')
    expect(row.querySelector('.card-key')?.textContent).toBe('WOR-003')
    expect(row.querySelector('.list-title')?.textContent).toBe('Alone')
    expect(row.querySelector('.waiting-pill')?.textContent).toBe('Waiting for you')
    expect(row.querySelector('.run-dot')).not.toBeNull()
    expect([...row.querySelectorAll('.label')].map(label => label.textContent)).toEqual(['a', 'b'])
    expect(row.querySelector('.label-more')?.textContent).toBe('+1')
    expect(row.querySelector('.avatar')).not.toBeNull()
    expect(row.querySelector('.row-age')?.textContent).toBe('3d')
  })

  it('opens a card on a click, and shows a title written as HTML as its characters', () => {
    const onOpen = vi.fn()
    const title = '<img src=x onerror=alert(1)>'
    const list = renderList(options([cardFixture({ id: 'WOR-003', title, statusId: 'todo' })], { onOpen }))
    expect(list.querySelector('img')).toBeNull()
    const button = list.querySelector<HTMLButtonElement>('button.list-title')!
    expect(button.textContent).toBe(title)
    button.click()
    expect(onOpen).toHaveBeenCalledWith('WOR-003')
  })

  it('indents a sub-task row under its parent in inside mode, with its own column icon', () => {
    const list = renderList(options([parent, child, lone]))
    const rows = [...list.querySelectorAll<HTMLElement>('.list-row')]
    const sub = rows.find(row => row.dataset.cardId === 'WOR-002')!
    expect(sub.dataset.depth).toBe('1')
    expect(sub.querySelector<HTMLElement>('.status-icon')?.dataset.category).toBe('unstarted')
    expect(sub.previousElementSibling).toBe(rows.find(row => row.dataset.cardId === 'WOR-001'))
    expect(sub.querySelector('.row-parent')).toBeNull()
  })

  it('keeps sub-task rows flat in cards mode, each with a short "↰ KEY" before its title', () => {
    const list = renderList(options([parent, child, lone], { mode: 'cards' }))
    const sub = [...list.querySelectorAll<HTMLElement>('.list-row')].find(row => row.dataset.cardId === 'WOR-002')!
    expect(sub.dataset.depth).toBe('0')
    expect(sub.querySelector('.row-parent')?.textContent).toBe('WOR-001')
    expect(sub.querySelector<HTMLElement>('.row-parent')?.title).toBe('Sub-task of WOR-001 · Ship it')
    expect(sub.querySelector('.row-parent + .list-title')).not.toBeNull()
  })

  it('fades a sub-task row that does not match a filter', () => {
    const list = renderList(options([parent, child], { faded: new Set(['WOR-002']) }))
    expect(list.querySelector<HTMLElement>('[data-card-id="WOR-002"]')?.hasAttribute('data-dim')).toBe(true)
    expect(list.querySelector<HTMLElement>('[data-card-id="WOR-001"]')?.hasAttribute('data-dim')).toBe(false)
  })
})

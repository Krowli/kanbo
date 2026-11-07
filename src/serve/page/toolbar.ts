import type { Display } from './display'
import { DEFAULT_DISPLAY } from './display'
import { button, el } from './dom'
import type { CardFilters, Priority } from './filters'
import { isFiltering, NO_FILTERS, PRIORITIES } from './filters'
import { boardIcon, chartIcon, closeIcon, displayIcon, filterIcon, listIcon, plusIcon, priorityIcon, searchIcon } from './icons'
import type { PopoverHandle } from './popover'
import { attachPopover } from './popover'

/**
 * The row of 28 px controls above the board: search and the card count at the
 * left; Filter, and "New" at the right; and, while a filter is on, a row of
 * removable chips. It holds no data of its own: every change is handed to the
 * page as the whole next set of filters.
 *
 * The toolbar is built once and `update`d on every render, so an open popover,
 * the search field and the focus in them survive a poll.
 */

export const PRIORITY_NAMES: Record<Priority, string> = { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low', none: 'None' }

export interface ToolbarOptions { workers: { key: string, label: string }[], labels: string[] }

export interface ToolbarState {
  filters: CardFilters
  display: Display
  options: ToolbarOptions
  counts: { shown: number, total: number }
}

export interface ToolbarActions {
  onFilters: (next: CardFilters) => void
  onDisplay: (next: Display) => void
  onNew: () => void
}

export interface Toolbar {
  element: HTMLElement
  update: (state: ToolbarState) => void
}

/** "12 cards", or "3 of 12" while a filter narrows them. */
export function countText(counts: { shown: number, total: number }, filtering: boolean): string {
  if (filtering) {
    return `${counts.shown} of ${counts.total}`
  }
  return counts.total === 1 ? '1 card' : `${counts.total} cards`
}

function without<T>(values: readonly T[], value: T): T[] {
  return values.filter(candidate => candidate !== value)
}

/** One checkbox or radio row. `key` lets a rebuilt popover give the focus back to the same control. */
function option(type: 'checkbox' | 'radio', key: string, checked: boolean, onChange: () => void, ...label: (Node | string)[]): HTMLLabelElement {
  const row = el('label', 'option')
  const input = el('input')
  input.type = type
  input.checked = checked
  input.dataset.key = key
  input.addEventListener('change', onChange)
  row.append(input, ...label)
  return row
}

function popoverSection(title: string, ...rows: HTMLElement[]): HTMLElement {
  const section = el('div', 'popover-section')
  section.setAttribute('role', 'group')
  section.setAttribute('aria-label', title)
  section.append(el('p', 'popover-title', title), ...rows)
  return section
}

/** How many separate filters are in force (the search text is shown in its own field). */
export function activeFilterCount(filters: CardFilters): number {
  return (filters.waiting ? 1 : 0) + (filters.running ? 1 : 0) + (filters.worker === null ? 0 : 1) + filters.priorities.length + filters.labels.length
}

export function createToolbar(actions: ToolbarActions): Toolbar {
  let state: ToolbarState = { filters: NO_FILTERS, display: DEFAULT_DISPLAY, options: { workers: [], labels: [] }, counts: { shown: 0, total: 0 } }
  const set = (next: CardFilters): void => actions.onFilters(next)

  const wrap = el('div', 'toolbar-wrap')
  const bar = el('div', 'toolbar')
  bar.setAttribute('role', 'search')

  const searchBox = el('label', 'search-box')
  const search = el('input', 'field filter-search')
  search.type = 'search'
  search.placeholder = 'Search cards'
  search.setAttribute('aria-label', 'Search cards')
  search.addEventListener('input', () => set({ ...state.filters, text: search.value }))
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && search.value !== '') {
      event.stopPropagation()
      search.value = ''
      set({ ...state.filters, text: '' })
    }
  })
  const clearSearch = el('button', 'icon-button search-clear')
  clearSearch.type = 'button'
  clearSearch.setAttribute('aria-label', 'Clear search')
  clearSearch.append(closeIcon())
  clearSearch.addEventListener('click', () => {
    search.value = ''
    set({ ...state.filters, text: '' })
    search.focus()
  })
  searchBox.append(searchIcon(), search, clearSearch)

  const count = el('span', 'toolbar-count')
  count.setAttribute('role', 'status')

  const filterAnchor = el('span', 'anchor')
  const filterButton = el('button', 'tool-button filter-button')
  filterButton.type = 'button'
  const filterBadge = el('span', 'badge')
  filterButton.append(filterIcon(), 'Filter', filterBadge)
  filterAnchor.append(filterButton)

  const displayAnchor = el('span', 'anchor')
  const displayButton = el('button', 'tool-button display-button')
  displayButton.type = 'button'
  displayButton.append(displayIcon(), 'Display')
  displayAnchor.append(displayButton)

  const viewSwitch = el('div', 'view-switch')
  viewSwitch.setAttribute('role', 'group')
  viewSwitch.setAttribute('aria-label', 'View')
  const viewButtons = (['board', 'list', 'analytics'] as const).map((view) => {
    const viewButton = el('button')
    viewButton.type = 'button'
    viewButton.dataset.view = view
    viewButton.title = view === 'board' ? 'Board' : view === 'list' ? 'List' : 'Analytics'
    viewButton.setAttribute('aria-label', viewButton.title)
    viewButton.append(view === 'board' ? boardIcon() : view === 'list' ? listIcon() : chartIcon())
    viewButton.addEventListener('click', () => {
      if (state.display.view !== view) {
        actions.onDisplay({ ...state.display, view })
      }
    })
    return viewButton
  })
  viewSwitch.append(...viewButtons)

  const addButton = el('button', 'primary')
  addButton.type = 'button'
  addButton.append(plusIcon(), 'New')
  addButton.addEventListener('click', actions.onNew)

  bar.append(searchBox, count, el('span', 'spacer'), filterAnchor, displayAnchor, viewSwitch, addButton)

  const chips = el('div', 'filter-chips')
  chips.hidden = true
  wrap.append(bar, chips)

  const buildFilterPopover = (): HTMLElement => {
    const { filters, options } = state
    const content = el('div')
    content.append(popoverSection('Status',
      option('checkbox', 'waiting', filters.waiting, () => set({ ...filters, waiting: !filters.waiting }), 'Waiting for you'),
      option('checkbox', 'running', filters.running, () => set({ ...filters, running: !filters.running }), 'Running now')))

    // A worker chosen earlier who no longer has a card still shows as chosen.
    const workers = [{ key: '', label: 'Anyone' }, { key: 'nobody', label: 'Nobody' }, ...options.workers]
    if (filters.worker !== null && !workers.some(worker => worker.key === filters.worker)) {
      workers.push({ key: filters.worker, label: filters.worker })
    }
    content.append(popoverSection('Worked by', ...workers.map(worker => option('radio', `who:${worker.key}`, (filters.worker ?? '') === worker.key,
      () => set({ ...filters, worker: worker.key === '' ? null : worker.key }), worker.label))))

    content.append(popoverSection('Priority', ...PRIORITIES.map((priority) => {
      const active = filters.priorities.includes(priority)
      return option('checkbox', `priority:${priority}`, active, () => set({
        ...filters,
        priorities: active ? without(filters.priorities, priority) : [...filters.priorities, priority],
      }), priorityIcon(priority), PRIORITY_NAMES[priority])
    })))

    // A label chosen earlier that no card has now stays listed, so it can be unchosen.
    const labels = [...new Set([...options.labels, ...filters.labels])]
    if (labels.length > 0) {
      content.append(popoverSection('Labels', ...labels.map((label) => {
        const active = filters.labels.includes(label)
        return option('checkbox', `label:${label}`, active, () => set({
          ...filters,
          labels: active ? without(filters.labels, label) : [...filters.labels, label],
        }), label)
      })))
    }
    return content
  }
  const filterPopover: PopoverHandle = attachPopover(filterAnchor, filterButton, 'Filter cards', buildFilterPopover, 'start')

  const buildDisplayPopover = (): HTMLElement => {
    const content = el('div')
    const asCards = state.display.subtasks === 'cards'
    const row = el('label', 'option')
    const input = el('input')
    input.type = 'checkbox'
    input.setAttribute('role', 'switch')
    input.checked = asCards
    input.dataset.key = 'subtasks'
    input.addEventListener('change', () => actions.onDisplay({ ...state.display, subtasks: asCards ? 'inside' : 'cards' }))
    row.append(input, 'Show sub-tasks as cards')
    content.append(popoverSection('Sub-tasks', row, el('p', 'option-hint', 'Off: a sub-task is a row inside its parent card. On: each is a card of its own, marked "Sub-task of".')))
    return content
  }
  const displayPopover: PopoverHandle = attachPopover(displayAnchor, displayButton, 'Display options', buildDisplayPopover, 'end')

  const chip = (text: string, remove: () => void): HTMLButtonElement => {
    const item = el('button', 'filter-chip')
    item.type = 'button'
    item.title = `Remove: ${text}`
    item.append(text, closeIcon())
    item.addEventListener('click', remove)
    return item
  }

  function renderChips(): void {
    const { filters } = state
    const workerLabel = filters.worker === null
      ? ''
      : filters.worker === 'nobody' ? 'Nobody' : state.options.workers.find(worker => worker.key === filters.worker)?.label ?? filters.worker
    const items = [
      ...(filters.waiting ? [chip('Waiting for you', () => set({ ...filters, waiting: false }))] : []),
      ...(filters.running ? [chip('Running now', () => set({ ...filters, running: false }))] : []),
      ...(filters.worker === null ? [] : [chip(`Worked by: ${workerLabel}`, () => set({ ...filters, worker: null }))]),
      ...filters.priorities.map(priority => chip(`Priority: ${PRIORITY_NAMES[priority]}`, () => set({ ...filters, priorities: without(filters.priorities, priority) }))),
      ...filters.labels.map(label => chip(`Label: ${label}`, () => set({ ...filters, labels: without(filters.labels, label) }))),
    ]
    chips.hidden = !isFiltering(filters)
    chips.replaceChildren(...items, ...(isFiltering(filters) ? [button('Clear', 'ghost filter-clear', () => set(NO_FILTERS))] : []))
  }

  return {
    element: wrap,
    update: (next) => {
      state = next
      const filtering = isFiltering(next.filters)
      // Not while the person is typing in it: the field already shows what they typed.
      if (search.value !== next.filters.text && document.activeElement !== search) {
        search.value = next.filters.text
      }
      clearSearch.hidden = search.value === ''
      count.textContent = countText(next.counts, filtering)
      const active = activeFilterCount(next.filters)
      filterBadge.textContent = String(active)
      filterBadge.hidden = active === 0
      for (const viewButton of viewButtons) {
        viewButton.setAttribute('aria-pressed', String(viewButton.dataset.view === next.display.view))
      }
      renderChips()
      // Analytics is about the whole board: no search, count or filters there, as in Modular.
      const analytics = next.display.view === 'analytics'
      for (const part of [searchBox, count, filterAnchor, displayAnchor]) {
        part.hidden = analytics
      }
      chips.hidden = analytics || !filtering
      if (analytics) {
        filterPopover.close()
        displayPopover.close()
      }
      filterPopover.refresh()
      displayPopover.refresh()
    },
  }
}

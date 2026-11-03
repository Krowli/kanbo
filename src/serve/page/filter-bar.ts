import { button, el } from './dom'
import type { CardFilters, Priority } from './filters'
import { isFiltering, NO_FILTERS, PRIORITIES } from './filters'

/** With more labels than this the label filter is a list to pick from, not a row of chips. */
const MAX_LABEL_CHIPS = 8

const PRIORITY_NAMES: Record<Priority, string> = { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low', none: 'None' }

function toggle(text: string, className: string, pressed: boolean, onClick: () => void): HTMLButtonElement {
  const element = button(text, `${className}${pressed ? ' active' : ''}`, onClick)
  element.setAttribute('aria-pressed', String(pressed))
  return element
}

function without<T>(values: readonly T[], value: T): T[] {
  return values.filter(candidate => candidate !== value)
}

/**
 * The row of controls above the board: search, who works a card, waiting and
 * running, priority and label. It holds nothing: every change is handed to
 * `onChange` as the whole next set of filters, and the page builds it again.
 */
export function renderFilterBar(
  filters: CardFilters,
  options: { workers: { key: string, label: string }[], labels: string[] },
  counts: { shown: number, total: number },
  onChange: (next: CardFilters) => void,
): HTMLElement {
  const bar = el('div', 'filter-bar')
  bar.setAttribute('role', 'search')

  const search = el('input', 'field filter-search')
  search.type = 'search'
  search.placeholder = 'Search cards'
  search.setAttribute('aria-label', 'Search cards')
  search.value = filters.text
  search.addEventListener('input', () => onChange({ ...filters, text: search.value }))
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && search.value !== '') {
      event.stopPropagation()
      search.value = ''
      onChange({ ...filters, text: '' })
    }
  })

  const worker = el('select', 'field filter-worker')
  worker.setAttribute('aria-label', 'Worked by')
  const choices = [{ key: '', label: 'Anyone' }, { key: 'nobody', label: 'Nobody' }, ...options.workers]
  // A worker chosen earlier who no longer has a card still shows as chosen.
  if (filters.worker !== null && !choices.some(choice => choice.key === filters.worker)) {
    choices.push({ key: filters.worker, label: filters.worker })
  }
  for (const choice of choices) {
    const option = el('option', undefined, choice.key === '' ? 'Worked by: Anyone' : choice.label)
    option.value = choice.key
    worker.append(option)
  }
  worker.value = filters.worker ?? ''
  worker.addEventListener('change', () => onChange({ ...filters, worker: worker.value === '' ? null : worker.value }))

  const priorities = el('span', 'filter-group')
  priorities.setAttribute('role', 'group')
  priorities.setAttribute('aria-label', 'Priority')
  for (const priority of PRIORITIES) {
    const active = filters.priorities.includes(priority)
    priorities.append(toggle(PRIORITY_NAMES[priority], 'filter-chip', active, () => onChange({
      ...filters,
      priorities: active ? without(filters.priorities, priority) : [...filters.priorities, priority],
    })))
  }

  bar.append(
    search,
    worker,
    toggle('Waiting for you', 'filter-toggle', filters.waiting, () => onChange({ ...filters, waiting: !filters.waiting })),
    toggle('Running now', 'filter-toggle', filters.running, () => onChange({ ...filters, running: !filters.running })),
    priorities,
  )

  // A label chosen earlier that no card has now stays visible, so it can be unchosen.
  const labels = [...new Set([...options.labels, ...filters.labels])]
  if (labels.length > 0 && labels.length <= MAX_LABEL_CHIPS) {
    const group = el('span', 'filter-group')
    group.setAttribute('role', 'group')
    group.setAttribute('aria-label', 'Labels')
    for (const label of labels) {
      const active = filters.labels.includes(label)
      group.append(toggle(label, 'filter-chip', active, () => onChange({
        ...filters,
        labels: active ? without(filters.labels, label) : [...filters.labels, label],
      })))
    }
    bar.append(group)
  }
  else if (labels.length > MAX_LABEL_CHIPS) {
    const select = el('select', 'field filter-labels')
    select.multiple = true
    select.setAttribute('aria-label', 'Labels')
    for (const label of labels) {
      const option = el('option', undefined, label)
      option.value = label
      option.selected = filters.labels.includes(label)
      select.append(option)
    }
    select.addEventListener('change', () => onChange({ ...filters, labels: [...select.selectedOptions].map(option => option.value) }))
    bar.append(select)
  }

  if (isFiltering(filters)) {
    bar.append(
      el('span', 'filter-count', countText(counts)),
      button('Clear', 'ghost filter-clear', () => onChange(NO_FILTERS)),
    )
  }
  return bar
}

function countText(counts: { shown: number, total: number }): string {
  return `Showing ${counts.shown} of ${counts.total}`
}

/** Say how many cards show, in a bar already on the page, so an open dropdown in it is left alone. */
export function updateFilterCount(bar: HTMLElement, counts: { shown: number, total: number }): void {
  const count = bar.querySelector('.filter-count')
  if (count) {
    count.textContent = countText(counts)
  }
}

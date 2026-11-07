// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CardFilters } from './filters'
import { DEFAULT_DISPLAY } from './display'
import { NO_FILTERS } from './filters'
import { closeOpenPopover } from './popover'
import type { ToolbarState } from './toolbar'
import { countText, createToolbar } from './toolbar'

const base: ToolbarState = { filters: NO_FILTERS, display: DEFAULT_DISPLAY, options: { workers: [], labels: [] }, counts: { shown: 1, total: 2 } }

function setup(state: Partial<ToolbarState> = {}) {
  const onFilters = vi.fn()
  const onNew = vi.fn()
  const onDisplay = vi.fn()
  const toolbar = createToolbar({ onFilters, onDisplay, onNew })
  document.body.append(toolbar.element)
  toolbar.update({ ...base, ...state })
  const find = (text: string) => [...toolbar.element.querySelectorAll('button')].find(item => item.textContent?.trim().startsWith(text))!
  return { toolbar, onFilters, onDisplay, onNew, find }
}

afterEach(() => {
  closeOpenPopover()
  document.body.replaceChildren()
})

describe('countText', () => {
  it('says how many cards, or how many of all while filtering', () => {
    expect(countText({ shown: 12, total: 12 }, false)).toBe('12 cards')
    expect(countText({ shown: 1, total: 1 }, false)).toBe('1 card')
    expect(countText({ shown: 3, total: 12 }, true)).toBe('3 of 12')
  })
})

describe('createToolbar', () => {
  it('shows a label written as HTML as its characters, in the Filter popover', () => {
    const { toolbar, find } = setup({ options: { workers: [], labels: ['<b>x</b>'] } })
    find('Filter').click()
    expect(toolbar.element.querySelector('b')).toBeNull()
    expect(toolbar.element.querySelector('.popover [data-key="label:<b>x</b>"]')?.parentElement?.textContent).toContain('<b>x</b>')
  })

  it('toggles "Waiting for you" through onFilters, from a checkbox in the Filter popover', () => {
    const { toolbar, onFilters, find } = setup()
    find('Filter').click()
    const box = toolbar.element.querySelector<HTMLInputElement>('[data-key="waiting"]')!
    expect(box.checked).toBe(false)
    box.click()
    expect(onFilters).toHaveBeenCalledWith({ ...NO_FILTERS, waiting: true })
    toolbar.update({ ...base, filters: { ...NO_FILTERS, waiting: true } })
    expect(toolbar.element.querySelector<HTMLInputElement>('[data-key="waiting"]')?.checked).toBe(true)
  })

  it('sets one worker, any priorities and any labels', () => {
    const { toolbar, onFilters, find } = setup({ options: { workers: [{ key: 'agent:claude', label: 'claude' }], labels: ['email'] } })
    find('Filter').click()
    toolbar.element.querySelector<HTMLInputElement>('[data-key="who:agent:claude"]')?.click()
    expect(onFilters).toHaveBeenLastCalledWith({ ...NO_FILTERS, worker: 'agent:claude' })
    toolbar.element.querySelector<HTMLInputElement>('[data-key="priority:high"]')?.click()
    expect(onFilters).toHaveBeenLastCalledWith({ ...NO_FILTERS, priorities: ['high'] })
    toolbar.element.querySelector<HTMLInputElement>('[data-key="label:email"]')?.click()
    expect(onFilters).toHaveBeenLastCalledWith({ ...NO_FILTERS, labels: ['email'] })
  })

  it('shows removable chips and Clear only while filtering, and Clear resets everything', () => {
    const none = setup()
    expect(none.toolbar.element.querySelector('.filter-chips')?.hasAttribute('hidden')).toBe(true)
    document.body.replaceChildren()
    const filters: CardFilters = { ...NO_FILTERS, priorities: ['high'], text: 'x' }
    const { toolbar, onFilters, find } = setup({ filters })
    const chips = [...toolbar.element.querySelectorAll('.filter-chips .filter-chip')].map(chip => chip.textContent)
    expect(chips).toEqual(['Priority: High'])
    toolbar.element.querySelector<HTMLButtonElement>('.filter-chips .filter-chip')?.click()
    expect(onFilters).toHaveBeenLastCalledWith({ ...filters, priorities: [] })
    find('Clear').click()
    expect(onFilters).toHaveBeenLastCalledWith(NO_FILTERS)
  })

  it('shows the count of cards, or "N of M" while filtering, and updates it in place', () => {
    const { toolbar } = setup({ filters: { ...NO_FILTERS, text: 'x' } })
    expect(toolbar.element.querySelector('.toolbar-count')?.textContent).toBe('1 of 2')
    const count = toolbar.element.querySelector('.toolbar-count')
    toolbar.update({ ...base, counts: { shown: 2, total: 2 } })
    expect(toolbar.element.querySelector('.toolbar-count')).toBe(count)
    expect(count?.textContent).toBe('2 cards')
  })

  it('leaves an open Filter popover and its focus alone while a poll updates it', () => {
    const { toolbar, find } = setup({ options: { workers: [], labels: ['email'] } })
    find('Filter').click()
    const box = toolbar.element.querySelector<HTMLInputElement>('[data-key="label:email"]')!
    box.focus()
    toolbar.update({ ...base, options: { workers: [], labels: ['email', 'ui'] } })
    expect(toolbar.element.querySelector('.popover')).not.toBeNull()
    expect(document.activeElement).toBe(toolbar.element.querySelector('[data-key="label:email"]'))
    expect(toolbar.element.querySelector('[data-key="label:ui"]')).not.toBeNull()
  })

  it('sends typed text, clears it with the × or Escape, and does not rebuild the search field', () => {
    const { toolbar, onFilters } = setup()
    const search = toolbar.element.querySelector<HTMLInputElement>('.filter-search')!
    search.value = 'race'
    search.dispatchEvent(new Event('input'))
    expect(onFilters).toHaveBeenLastCalledWith({ ...NO_FILTERS, text: 'race' })
    toolbar.update({ ...base, filters: { ...NO_FILTERS, text: 'race' } })
    expect(toolbar.element.querySelector('.filter-search')).toBe(search)
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(onFilters).toHaveBeenLastCalledWith({ ...NO_FILTERS, text: '' })
  })

  it('counts the filters in force on the Filter button, and New calls onNew', () => {
    const { onNew, find } = setup({ filters: { ...NO_FILTERS, waiting: true, priorities: ['high', 'low'] } })
    expect(find('Filter').querySelector('.badge')?.textContent).toBe('3')
    find('New').click()
    expect(onNew).toHaveBeenCalled()
  })

  it('has a Display popover whose switch shows sub-tasks as cards, off by default', () => {
    const { toolbar, onDisplay, find } = setup()
    find('Display').click()
    const box = toolbar.element.querySelector<HTMLInputElement>('.popover [data-key="subtasks"]')!
    expect(box.getAttribute('role')).toBe('switch')
    expect(box.parentElement?.textContent).toContain('Show sub-tasks as cards')
    expect(box.checked).toBe(false)
    box.click()
    expect(onDisplay).toHaveBeenCalledWith({ subtasks: 'cards' })
    toolbar.update({ ...base, display: { subtasks: 'cards' } })
    expect(toolbar.element.querySelector<HTMLInputElement>('.popover [data-key="subtasks"]')?.checked).toBe(true)
  })
})

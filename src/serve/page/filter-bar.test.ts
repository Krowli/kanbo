// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

import { renderFilterBar, updateFilterCount } from './filter-bar'
import { NO_FILTERS } from './filters'

const counts = { shown: 1, total: 2 }

describe('renderFilterBar', () => {
  it('shows a label written as HTML as its characters', () => {
    const bar = renderFilterBar(NO_FILTERS, { workers: [], labels: ['<b>x</b>'] }, counts, () => {})
    expect(bar.querySelector('b')).toBeNull()
    expect(bar.querySelector('[aria-label="Labels"] .filter-chip')?.textContent).toBe('<b>x</b>')
  })

  it('toggles "Waiting for you" through onChange', () => {
    const onChange = vi.fn()
    const bar = renderFilterBar(NO_FILTERS, { workers: [], labels: [] }, counts, onChange)
    const waiting = [...bar.querySelectorAll('button')].find(item => item.textContent === 'Waiting for you')!
    expect(waiting.getAttribute('aria-pressed')).toBe('false')
    waiting.click()
    expect(onChange).toHaveBeenCalledWith({ ...NO_FILTERS, waiting: true })
    const pressed = renderFilterBar({ ...NO_FILTERS, waiting: true }, { workers: [], labels: [] }, counts, onChange)
    expect([...pressed.querySelectorAll('button')].find(item => item.textContent === 'Waiting for you')?.getAttribute('aria-pressed')).toBe('true')
  })

  it('shows the count and Clear only while filtering, and Clear resets everything', () => {
    const onChange = vi.fn()
    expect(renderFilterBar(NO_FILTERS, { workers: [], labels: [] }, counts, onChange).querySelector('.filter-clear')).toBeNull()
    const bar = renderFilterBar({ ...NO_FILTERS, text: 'x' }, { workers: [], labels: [] }, counts, onChange)
    expect(bar.querySelector('.filter-count')?.textContent).toBe('Showing 1 of 2')
    bar.querySelector<HTMLButtonElement>('.filter-clear')?.click()
    expect(onChange).toHaveBeenCalledWith(NO_FILTERS)
  })

  it('updates the count in place, leaving the dropdowns as they are', () => {
    const bar = renderFilterBar({ ...NO_FILTERS, text: 'x' }, { workers: [{ key: 'user', label: 'You' }], labels: [] }, counts, () => {})
    const select = bar.querySelector('select')
    updateFilterCount(bar, { shown: 5, total: 9 })
    expect(bar.querySelector('.filter-count')?.textContent).toBe('Showing 5 of 9')
    expect(bar.querySelector('select')).toBe(select)
  })

  it('sends typed text, and Escape in the search clears it', () => {
    const onChange = vi.fn()
    const bar = renderFilterBar(NO_FILTERS, { workers: [], labels: [] }, counts, onChange)
    const search = bar.querySelector<HTMLInputElement>('.filter-search')!
    search.value = 'race'
    search.dispatchEvent(new Event('input'))
    expect(onChange).toHaveBeenLastCalledWith({ ...NO_FILTERS, text: 'race' })
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(onChange).toHaveBeenLastCalledWith({ ...NO_FILTERS, text: '' })
  })
})

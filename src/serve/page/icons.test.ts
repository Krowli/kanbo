// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'

import { priorityIcon, statusIcon } from './icons'

describe('priorityIcon', () => {
  it('draws one to four bars for low to urgent, four heights from the bottom up', () => {
    const bars = (priority: Parameters<typeof priorityIcon>[0]) => [...priorityIcon(priority).querySelectorAll('rect')]
    expect([bars('low').length, bars('medium').length, bars('high').length, bars('urgent').length]).toEqual([1, 2, 3, 4])
    expect(bars('urgent').map(bar => Number(bar.getAttribute('height')))).toEqual([4, 6, 8, 10])
    expect(bars('urgent').every(bar => Number(bar.getAttribute('y')) + Number(bar.getAttribute('height')) === 12)).toBe(true)
  })

  it('draws none as a single horizontal line, and carries its level for the stylesheet', () => {
    const none = priorityIcon('none')
    expect(none.querySelectorAll('rect')).toHaveLength(0)
    expect(none.querySelectorAll('path')).toHaveLength(1)
    expect(none.dataset.priority).toBe('none')
  })

  it('is hidden from screen readers', () => {
    expect(priorityIcon('high').getAttribute('aria-hidden')).toBe('true')
  })
})

describe('statusIcon', () => {
  it('draws each category differently and marks it for the stylesheet', () => {
    const categories = ['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled'] as const
    const drawn = categories.map(category => [...statusIcon(category).children].map(child => child.outerHTML).join(''))
    expect(new Set(drawn).size).toBe(6)
    expect(statusIcon('started').dataset.category).toBe('started')
  })

  it('takes a column with no category for unstarted', () => {
    expect(statusIcon(null).children[0]!.outerHTML).toBe(statusIcon('unstarted').children[0]!.outerHTML)
    expect(statusIcon(null).dataset.category).toBe('unstarted')
  })
})

import { describe, expect, it } from 'vitest'

import { DEFAULT_DISPLAY, readDisplay, writeDisplay } from './display'

describe('display', () => {
  it('shows sub-tasks inside their parent unless the address says "cards"', () => {
    expect(readDisplay('')).toEqual(DEFAULT_DISPLAY)
    expect(DEFAULT_DISPLAY.subtasks).toBe('inside')
    expect(readDisplay('?subtasks=cards').subtasks).toBe('cards')
    expect(readDisplay('?subtasks=whatever').subtasks).toBe('inside')
  })

  it('round-trips through the query string and keeps every other param', () => {
    const written = writeDisplay({ ...DEFAULT_DISPLAY, subtasks: 'cards' }, '?project=p1&q=race')
    expect(new URLSearchParams(written).get('subtasks')).toBe('cards')
    expect(new URLSearchParams(written).get('project')).toBe('p1')
    expect(readDisplay(written).subtasks).toBe('cards')
  })

  it('leaves the default out of the address, and removes an earlier choice', () => {
    expect(writeDisplay(DEFAULT_DISPLAY, '?subtasks=cards&project=p1')).toBe('?project=p1')
    expect(writeDisplay(DEFAULT_DISPLAY, '')).toBe('')
  })
})

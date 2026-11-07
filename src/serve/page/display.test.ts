import { describe, expect, it } from 'vitest'

import { DEFAULT_DISPLAY, readDisplay, writeDisplay } from './display'

describe('display', () => {
  it('shows sub-tasks inside their parent unless the address says "cards"', () => {
    expect(readDisplay('')).toEqual(DEFAULT_DISPLAY)
    expect(DEFAULT_DISPLAY.subtasks).toBe('inside')
    expect(readDisplay('?subtasks=cards').subtasks).toBe('cards')
    expect(readDisplay('?subtasks=whatever').subtasks).toBe('inside')
    expect(DEFAULT_DISPLAY.view).toBe('board')
    expect(readDisplay('?view=list').view).toBe('list')
    expect(readDisplay('?view=grid').view).toBe('board')
    expect(readDisplay('?view=analytics').view).toBe('analytics')
    expect(DEFAULT_DISPLAY).toMatchObject({ range: 12, sprint: null })
  })

  it('round-trips through the query string and keeps every other param', () => {
    const written = writeDisplay({ ...DEFAULT_DISPLAY, subtasks: 'cards' }, '?project=p1&q=race')
    expect(new URLSearchParams(written).get('subtasks')).toBe('cards')
    expect(new URLSearchParams(written).get('project')).toBe('p1')
    expect(readDisplay(written).subtasks).toBe('cards')
    const list = writeDisplay({ ...DEFAULT_DISPLAY, view: 'list' }, '?project=p1')
    expect(new URLSearchParams(list).get('view')).toBe('list')
    expect(readDisplay(list)).toEqual({ ...DEFAULT_DISPLAY, view: 'list' })
  })

  it('leaves the default out of the address, and removes an earlier choice', () => {
    expect(writeDisplay(DEFAULT_DISPLAY, '?subtasks=cards&view=list&project=p1')).toBe('?project=p1')
    expect(writeDisplay(DEFAULT_DISPLAY, '')).toBe('')
  })

  it('keeps the range and the sprint for Analytics only, with 12 weeks and no sprint left out', () => {
    const four = writeDisplay({ ...DEFAULT_DISPLAY, view: 'analytics', range: 4 }, '?project=p1')
    expect(readDisplay(four)).toEqual({ ...DEFAULT_DISPLAY, view: 'analytics', range: 4 })
    expect(new URLSearchParams(four).get('project')).toBe('p1')
    const sprint = writeDisplay({ ...DEFAULT_DISPLAY, view: 'analytics', sprint: 'm1' }, '')
    expect(new URLSearchParams(sprint).get('sprint')).toBe('m1')
    expect(new URLSearchParams(sprint).has('range')).toBe(false)
    expect(writeDisplay({ ...DEFAULT_DISPLAY, view: 'analytics' }, '')).toBe('?view=analytics')
    expect(writeDisplay({ ...DEFAULT_DISPLAY, view: 'board', range: 26, sprint: 'm1' }, '?range=4&sprint=x')).toBe('')
    expect(readDisplay('?range=7').range).toBe(12)
  })
})

import { describe, expect, it } from 'vitest'

import { clearSelection, EMPTY_SELECTION, extendSelection, isSelected, pruneSelection, selectRange, toggleSelection } from './selection'

const order = ['A', 'B', 'C', 'D', 'E']
const ids = (selection: { ids: ReadonlySet<string> }) => [...selection.ids].sort()

describe('toggleSelection', () => {
  it('adds a card, takes it out again, and remembers the last one touched as the anchor', () => {
    const one = toggleSelection(EMPTY_SELECTION, 'B')
    expect(ids(one)).toEqual(['B'])
    expect(one.anchor).toBe('B')
    const two = toggleSelection(one, 'D')
    expect(ids(two)).toEqual(['B', 'D'])
    expect(ids(toggleSelection(two, 'B'))).toEqual(['D'])
    expect(isSelected(two, 'D')).toBe(true)
    expect(isSelected(two, 'A')).toBe(false)
  })

  it('does not change the selection it was given', () => {
    const before = toggleSelection(EMPTY_SELECTION, 'A')
    toggleSelection(before, 'B')
    expect(ids(before)).toEqual(['A'])
  })
})

describe('selectRange', () => {
  it('selects every card between the anchor and the one clicked, both ends included, either way round', () => {
    const forward = selectRange(toggleSelection(EMPTY_SELECTION, 'B'), order, 'D')
    expect(ids(forward)).toEqual(['B', 'C', 'D'])
    const backward = selectRange(toggleSelection(EMPTY_SELECTION, 'D'), order, 'B')
    expect(ids(backward)).toEqual(['B', 'C', 'D'])
  })

  it('adds to what was already selected, and keeps the anchor', () => {
    const start = toggleSelection(toggleSelection(EMPTY_SELECTION, 'E'), 'A')
    const range = selectRange(start, order, 'C')
    expect(ids(range)).toEqual(['A', 'B', 'C', 'E'])
    expect(range.anchor).toBe('A')
  })

  it('selects just the card clicked when the anchor is not in this column or group', () => {
    const elsewhere = toggleSelection(EMPTY_SELECTION, 'X')
    const range = selectRange(elsewhere, order, 'C')
    expect(ids(range)).toEqual(['C', 'X'])
    expect(range.anchor).toBe('C')
    expect(ids(selectRange(EMPTY_SELECTION, order, 'C'))).toEqual(['C'])
  })
})

describe('extendSelection', () => {
  it('selects the focused card and the one the focus moves to', () => {
    const next = extendSelection(EMPTY_SELECTION, 'B', 'C')
    expect(ids(next)).toEqual(['B', 'C'])
    expect(ids(extendSelection(next, 'C', 'D'))).toEqual(['B', 'C', 'D'])
  })
})

describe('clearSelection and pruneSelection', () => {
  it('empties the selection', () => {
    expect(ids(clearSelection())).toEqual([])
    expect(clearSelection().anchor).toBeNull()
  })

  it('survives a refresh for the cards that still exist, and forgets the rest', () => {
    const selected = selectRange(toggleSelection(EMPTY_SELECTION, 'A'), order, 'C')
    const after = pruneSelection(selected, new Set(['A', 'C', 'Z']))
    expect(ids(after)).toEqual(['A', 'C'])
    expect(after.anchor).toBe('A')
    expect(pruneSelection(toggleSelection(EMPTY_SELECTION, 'B'), new Set(['A'])).anchor).toBeNull()
  })

  it('hands back the same selection when nothing was lost', () => {
    const selected = toggleSelection(EMPTY_SELECTION, 'A')
    expect(pruneSelection(selected, new Set(['A', 'B']))).toBe(selected)
  })
})

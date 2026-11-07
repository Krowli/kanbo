// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { KeyboardHost, KeyState } from './keyboard'
import { handleKey, isTypingTarget, keyAction, moveFocus, readLayout } from './keyboard'

const idle: KeyState = { shift: false, modifier: false, typing: false, popoverOpen: false, dialogOpen: false, hasSelection: false }

describe('keyAction', () => {
  it('moves down with j and ↓, up with k and ↑, and between columns with ← and →', () => {
    expect(keyAction('j', idle)).toEqual({ type: 'move', dy: 1, extend: false })
    expect(keyAction('ArrowDown', idle)).toEqual({ type: 'move', dy: 1, extend: false })
    expect(keyAction('k', idle)).toEqual({ type: 'move', dy: -1, extend: false })
    expect(keyAction('ArrowUp', idle)).toEqual({ type: 'move', dy: -1, extend: false })
    expect(keyAction('ArrowLeft', idle)).toEqual({ type: 'column', dx: -1 })
    expect(keyAction('ArrowRight', idle)).toEqual({ type: 'column', dx: 1 })
  })

  it('extends the selection with Shift and j or k, whichever case the browser reports', () => {
    expect(keyAction('J', { ...idle, shift: true })).toEqual({ type: 'move', dy: 1, extend: true })
    expect(keyAction('K', { ...idle, shift: true })).toEqual({ type: 'move', dy: -1, extend: true })
    expect(keyAction('ArrowDown', { ...idle, shift: true })).toEqual({ type: 'move', dy: 1, extend: true })
  })

  it('opens with Enter or Space, toggles the selection with x, and goes to the search with /', () => {
    expect(keyAction('Enter', idle)).toEqual({ type: 'open' })
    expect(keyAction(' ', idle)).toEqual({ type: 'open' })
    expect(keyAction('x', idle)).toEqual({ type: 'toggle' })
    expect(keyAction('/', idle)).toEqual({ type: 'search' })
  })

  it('lets Escape close the dialog first, then a popover, then clear the selection', () => {
    const everything = { ...idle, dialogOpen: true, popoverOpen: true, hasSelection: true }
    expect(keyAction('Escape', everything)).toEqual({ type: 'close-dialog' })
    expect(keyAction('Escape', { ...everything, dialogOpen: false })).toEqual({ type: 'close-popover' })
    expect(keyAction('Escape', { ...idle, hasSelection: true })).toEqual({ type: 'clear-selection' })
    expect(keyAction('Escape', idle)).toBeNull()
  })

  it('does nothing while typing, and nothing with a modifier held', () => {
    for (const key of ['j', 'k', 'x', '/', 'Enter', 'ArrowDown']) {
      expect(keyAction(key, { ...idle, typing: true })).toBeNull()
      expect(keyAction(key, { ...idle, modifier: true })).toBeNull()
    }
    expect(keyAction('Escape', { ...idle, typing: true, hasSelection: true })).toBeNull()
    expect(keyAction('Escape', { ...idle, typing: true, dialogOpen: true })).toEqual({ type: 'close-dialog' })
  })

  it('does nothing but Escape while a popover or the dialog is open, and ignores other keys', () => {
    for (const open of [{ dialogOpen: true }, { popoverOpen: true }]) {
      for (const key of ['j', 'k', 'x', '/', 'Enter', 'ArrowLeft']) {
        expect(keyAction(key, { ...idle, ...open })).toBeNull()
      }
    }
    expect(keyAction('a', idle)).toBeNull()
    expect(keyAction('Tab', idle)).toBeNull()
  })
})

describe('moveFocus', () => {
  const layout = [['A1', 'A2', 'A3'], [], ['C1', 'C2']]

  it('starts at the first card when nothing is focused', () => {
    expect(moveFocus(layout, null, 0, 1)).toBe('A1')
    expect(moveFocus(layout, null, 1, 0)).toBe('A1')
    expect(moveFocus([[], []], null, 0, 1)).toBeNull()
  })

  it('moves within a column and stops at its ends', () => {
    expect(moveFocus(layout, 'A1', 0, 1)).toBe('A2')
    expect(moveFocus(layout, 'A3', 0, 1)).toBe('A3')
    expect(moveFocus(layout, 'A1', 0, -1)).toBe('A1')
  })

  it('moves to the next column that has cards, at the same height or the nearest', () => {
    expect(moveFocus(layout, 'A2', 1, 0)).toBe('C2')
    expect(moveFocus(layout, 'A3', 1, 0)).toBe('C2')
    expect(moveFocus(layout, 'C1', -1, 0)).toBe('A1')
    expect(moveFocus(layout, 'C2', 1, 0)).toBe('C2')
  })

  it('stays where it is for a card it does not know', () => {
    expect(moveFocus(layout, 'ZZ', 0, 1)).toBe('A1')
  })
})

describe('isTypingTarget', () => {
  it('is true for text fields, selects and editable elements, and false for buttons and checkboxes', () => {
    const make = (tag: string, type?: string) => {
      const element = document.createElement(tag)
      if (type) {
        (element as HTMLInputElement).type = type
      }
      return element
    }
    expect(isTypingTarget(make('textarea'))).toBe(true)
    expect(isTypingTarget(make('input', 'text'))).toBe(true)
    expect(isTypingTarget(make('input', 'search'))).toBe(true)
    expect(isTypingTarget(make('select'))).toBe(true)
    expect(isTypingTarget(make('input', 'checkbox'))).toBe(false)
    expect(isTypingTarget(make('button'))).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })
})

describe('on a page of cards', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  function page() {
    const board = document.createElement('div')
    const column = (ids: string[]) => {
      const cards = document.createElement('div')
      cards.className = 'column-cards'
      for (const id of ids) {
        const card = document.createElement('article')
        card.className = 'card'
        card.dataset.cardId = id
        const title = document.createElement('button')
        title.className = 'card-title'
        title.textContent = id
        card.append(title)
        cards.append(card)
      }
      return cards
    }
    board.append(column(['A1', 'A2']), column(['B1']))
    document.body.append(board)
    const calls = { open: vi.fn(), toggle: vi.fn(), extend: vi.fn(), search: vi.fn(), closeDialog: vi.fn(), closePopover: vi.fn(), clearSelection: vi.fn() }
    const host = (over: Partial<ReturnType<KeyboardHost['state']>> = {}): KeyboardHost => ({
      layout: () => readLayout(board),
      focusedId: () => document.activeElement?.closest<HTMLElement>('.card')?.dataset.cardId ?? null,
      focus: id => board.querySelector<HTMLElement>(`[data-card-id="${id}"] .card-title`)?.focus(),
      state: () => ({ typing: false, popoverOpen: false, dialogOpen: false, hasSelection: false, ...over }),
      ...calls,
    })
    return { board, host, calls }
  }

  const press = (key: string, host: KeyboardHost, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
    let handled = false
    // Dispatched from the focused element, as the browser does, so the handler sees a real target.
    document.addEventListener('keydown', (arrived) => {
      handled = handleKey(arrived as KeyboardEvent, host)
    }, { once: true })
    ;(document.activeElement ?? document.body).dispatchEvent(event)
    return { event, handled }
  }

  it('reads the board as columns of card ids, top to bottom', () => {
    expect(readLayout(page().board)).toEqual([['A1', 'A2'], ['B1']])
  })

  it('reads the list view as one column of every row', () => {
    const root = document.createElement('div')
    const list = document.createElement('div')
    list.className = 'list'
    for (const id of ['X', 'Y']) {
      const row = document.createElement('div')
      row.className = 'list-row'
      row.dataset.cardId = id
      list.append(row)
    }
    root.append(list)
    expect(readLayout(root)).toEqual([['X', 'Y']])
  })

  it('moves the focus with j, and opens the second card with Enter', () => {
    const { host, calls } = page()
    const h = host()
    expect(press('j', h).handled).toBe(true)
    expect(press('j', h).handled).toBe(true)
    expect(document.activeElement?.textContent).toBe('A2')
    const enter = press('Enter', h)
    expect(enter.handled).toBe(true)
    expect(enter.event.defaultPrevented).toBe(true)
    expect(calls.open).toHaveBeenCalledWith('A2')
    expect(calls.open).toHaveBeenCalledTimes(1)
  })

  it('moves between columns with → and back with ←', () => {
    const { host } = page()
    const h = host()
    press('j', h)
    press('ArrowRight', h)
    expect(document.activeElement?.textContent).toBe('B1')
    press('ArrowLeft', h)
    expect(document.activeElement?.textContent).toBe('A1')
  })

  it('toggles the focused card with x, and extends with Shift and j', () => {
    const { host, calls } = page()
    const h = host()
    press('j', h)
    press('x', h)
    expect(calls.toggle).toHaveBeenCalledWith('A1')
    press('J', h, { shiftKey: true })
    expect(calls.extend).toHaveBeenCalledWith('A1', 'A2')
    expect(document.activeElement?.textContent).toBe('A2')
  })

  it('leaves a key alone while typing, and does not prevent its default', () => {
    const { host, calls } = page()
    const { event, handled } = press('j', host({ typing: true }))
    expect(handled).toBe(false)
    expect(event.defaultPrevented).toBe(false)
    expect(calls.open).not.toHaveBeenCalled()
  })

  it('sends / to the search, and Escape to the dialog, the popover or the selection in turn', () => {
    const { host, calls } = page()
    press('/', host())
    expect(calls.search).toHaveBeenCalled()
    press('Escape', host({ dialogOpen: true, hasSelection: true }))
    expect(calls.closeDialog).toHaveBeenCalled()
    expect(calls.clearSelection).not.toHaveBeenCalled()
    press('Escape', host({ popoverOpen: true }))
    expect(calls.closePopover).toHaveBeenCalled()
    press('Escape', host({ hasSelection: true }))
    expect(calls.clearSelection).toHaveBeenCalled()
  })

  it('leaves Enter to the checkbox in a card, which keeps its own', () => {
    const { board, host, calls } = page()
    const box = document.createElement('input')
    box.type = 'checkbox'
    board.querySelector('.card')?.prepend(box)
    box.focus()
    expect(press('Enter', host()).handled).toBe(false)
    expect(calls.open).not.toHaveBeenCalled()
  })

  it('has nothing to open or toggle when no card is focused', () => {
    const { host, calls } = page()
    expect(press('Enter', host()).handled).toBe(false)
    expect(press('x', host()).handled).toBe(false)
    expect(calls.open).not.toHaveBeenCalled()
    expect(calls.toggle).not.toHaveBeenCalled()
  })
})

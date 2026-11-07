/**
 * Linear-style keys for the board and the list: j/k or ↑/↓ between cards,
 * ←/→ between columns, Enter or Space to open, x to pick, Shift with a
 * movement key to extend the pick, / for the search, Escape to close the
 * dialog, then a popover, then clear the pick.
 *
 * `keyAction` is the pure part — a key and what the page is doing give an
 * action — and `handleKey` runs an action against the page through a host
 * the page provides, so the whole thing is tested with no real page.
 */

export interface KeyState {
  shift: boolean
  /** Ctrl, Cmd or Alt is held: the key is the browser's, not ours. */
  modifier: boolean
  /** The focus is in a text field, a select or an editable element. */
  typing: boolean
  popoverOpen: boolean
  dialogOpen: boolean
  hasSelection: boolean
}

export type KeyAction =
  | { type: 'move', dy: 1 | -1, extend: boolean }
  | { type: 'column', dx: 1 | -1 }
  | { type: 'open' }
  | { type: 'toggle' }
  | { type: 'search' }
  | { type: 'close-dialog' }
  | { type: 'close-popover' }
  | { type: 'clear-selection' }

/** What a key means right now, or `null` when it is not ours. */
export function keyAction(key: string, state: KeyState): KeyAction | null {
  if (state.modifier) {
    return null
  }
  // Escape closes the dialog even from the note being written in it; every other key is the field's own.
  if (state.typing) {
    return key === 'Escape' && state.dialogOpen ? { type: 'close-dialog' } : null
  }
  if (key === 'Escape') {
    if (state.dialogOpen) {
      return { type: 'close-dialog' }
    }
    if (state.popoverOpen) {
      return { type: 'close-popover' }
    }
    return state.hasSelection ? { type: 'clear-selection' } : null
  }
  if (state.dialogOpen || state.popoverOpen) {
    return null
  }
  switch (key) {
    case 'j':
    case 'J':
    case 'ArrowDown':
      return { type: 'move', dy: 1, extend: state.shift }
    case 'k':
    case 'K':
    case 'ArrowUp':
      return { type: 'move', dy: -1, extend: state.shift }
    case 'ArrowLeft':
      return { type: 'column', dx: -1 }
    case 'ArrowRight':
      return { type: 'column', dx: 1 }
    case 'Enter':
    case ' ':
      return { type: 'open' }
    case 'x':
    case 'X':
      return { type: 'toggle' }
    case '/':
      return { type: 'search' }
    default:
      return null
  }
}

/**
 * Where the focus goes from `current` (`null`, or a card not in the layout,
 * means nothing is focused yet): `dy` moves within the column and stops at its
 * ends; `dx` moves to the next column that has cards, at the same height or
 * the nearest one. `layout` is the cards' ids, column by column, top to bottom.
 */
export function moveFocus(layout: readonly (readonly string[])[], current: string | null, dx: number, dy: number): string | null {
  const columns = layout.map((ids, index) => ({ ids, index })).filter(column => column.ids.length > 0)
  if (columns.length === 0) {
    return null
  }
  const here = columns.find(column => column.ids.includes(current ?? ''))
  if (!here) {
    return columns[0]!.ids[0]!
  }
  const row = here.ids.indexOf(current!)
  if (dy !== 0) {
    return here.ids[Math.min(here.ids.length - 1, Math.max(0, row + dy))]!
  }
  const position = columns.indexOf(here)
  const next = columns[position + Math.sign(dx)]
  return next ? next.ids[Math.min(row, next.ids.length - 1)]! : current
}

/** Whether a key pressed here is going into text: a text field, a select, an editable element. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }
  if (target.isContentEditable || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') {
    return true
  }
  return target instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'submit'].includes(target.type)
}

/** The cards' ids column by column (the board), or all the rows as one column (the list). */
export function readLayout(root: ParentNode): string[][] {
  const idsIn = (container: ParentNode, selector: string): string[] =>
    [...container.querySelectorAll<HTMLElement>(selector)].map(item => item.dataset.cardId!).filter(Boolean)
  if (root.querySelector('.list')) {
    return [idsIn(root, '.list-row')]
  }
  return [...root.querySelectorAll('.column-cards')].map(column => idsIn(column, '.card'))
}

export interface KeyboardHost {
  layout: () => string[][]
  /** The card the focus is on, or `null`. */
  focusedId: () => string | null
  focus: (cardId: string) => void
  state: () => Pick<KeyState, 'typing' | 'popoverOpen' | 'dialogOpen' | 'hasSelection'>
  open: (cardId: string) => void
  toggle: (cardId: string) => void
  /** Pick `from` and `to`, the focus having moved from one to the other. */
  extend: (from: string, to: string) => void
  search: () => void
  closeDialog: () => void
  closePopover: () => void
  clearSelection: () => void
}

/** Run the key against the page. `true` when it was ours (its default is prevented). */
export function handleKey(event: KeyboardEvent, host: KeyboardHost): boolean {
  const action = keyAction(event.key, {
    shift: event.shiftKey,
    modifier: event.metaKey || event.ctrlKey || event.altKey,
    ...host.state(),
  })
  if (!action) {
    return false
  }
  const focused = host.focusedId()
  switch (action.type) {
    case 'move':
    case 'column': {
      const next = action.type === 'move' ? moveFocus(host.layout(), focused, 0, action.dy) : moveFocus(host.layout(), focused, action.dx, 0)
      if (!next) {
        return false
      }
      if (action.type === 'move' && action.extend && focused && next !== focused) {
        host.extend(focused, next)
      }
      host.focus(next)
      break
    }
    case 'open':
      // Another control in the card (its checkbox, a sub-task row) keeps its own Enter and Space.
      if (!focused || (event.target instanceof HTMLElement && event.target.closest('button, a, input, select, textarea, summary') && !event.target.closest('.card-title, .list-title'))) {
        return false
      }
      host.open(focused)
      break
    case 'toggle':
      if (!focused) {
        return false
      }
      host.toggle(focused)
      break
    case 'search':
      host.search()
      break
    case 'close-dialog':
      host.closeDialog()
      break
    case 'close-popover':
      host.closePopover()
      break
    case 'clear-selection':
      host.clearSelection()
      break
  }
  event.preventDefault()
  return true
}

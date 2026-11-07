import type { ServeCardView, ServeStatusView } from '../views'
import { el } from './dom'
import { checkIcon, chevronIcon, closeIcon, priorityIcon, statusIcon } from './icons'
import { PRIORITY_WORDS } from './parts'
import type { PopoverHandle } from './popover'
import { attachPopover } from './popover'

/**
 * The bar that floats at the bottom while cards are selected: how many, a
 * Status menu and a Priority menu that change every selected card, and a cross
 * that clears the selection. It is built once and `update`d, so an open menu
 * stays open as the count changes. Delete is not here: the board has none.
 */

export interface SelectionBarActions {
  onMove: (statusId: string) => void
  onPriority: (priority: ServeCardView['priority']) => void
  onClear: () => void
}

export interface SelectionBarState {
  count: number
  statuses: readonly ServeStatusView[]
}

export interface SelectionBar {
  element: HTMLElement
  update: (state: SelectionBarState) => void
}

const PRIORITY_ORDER: ServeCardView['priority'][] = ['urgent', 'high', 'medium', 'low', 'none']

export function createSelectionBar(actions: SelectionBarActions): SelectionBar {
  let state: SelectionBarState = { count: 0, statuses: [] }
  const bar = el('div', 'selection-bar')
  bar.setAttribute('role', 'toolbar')
  bar.setAttribute('aria-label', 'Selected cards')
  bar.hidden = true

  const count = el('span', 'selection-count')
  const summary = el('span', 'selection-summary')
  summary.append(checkIcon(), count)

  const menuButton = (label: string): { anchor: HTMLElement, trigger: HTMLButtonElement } => {
    const anchor = el('span', 'anchor')
    const trigger = el('button', 'tool-button')
    trigger.type = 'button'
    trigger.append(label, chevronIcon())
    anchor.append(trigger)
    return { anchor, trigger }
  }
  const menuItem = (onPick: () => void, ...content: (Node | string)[]): HTMLButtonElement => {
    const item = el('button', 'menu-item')
    item.type = 'button'
    item.append(...content)
    item.addEventListener('click', onPick)
    return item
  }

  const status = menuButton('Status')
  const statusMenu: PopoverHandle = attachPopover(status.anchor, status.trigger, 'Move to column', () => {
    const content = el('div', 'menu')
    content.append(...state.statuses.map(column => menuItem(() => {
      statusMenu.close()
      actions.onMove(column.id)
    }, statusIcon(column.category), column.name)))
    return content
  }, 'start', 'top')

  const priority = menuButton('Priority')
  const priorityMenu: PopoverHandle = attachPopover(priority.anchor, priority.trigger, 'Set priority', () => {
    const content = el('div', 'menu')
    content.append(...PRIORITY_ORDER.map(level => menuItem(() => {
      priorityMenu.close()
      actions.onPriority(level)
    }, priorityIcon(level), PRIORITY_WORDS[level])))
    return content
  }, 'start', 'top')

  const clear = el('button', 'icon-button selection-clear')
  clear.type = 'button'
  clear.setAttribute('aria-label', 'Clear selection')
  clear.title = 'Clear selection (Esc)'
  clear.append(closeIcon())
  clear.addEventListener('click', actions.onClear)

  bar.append(summary, status.anchor, priority.anchor, el('span', 'divider'), clear)

  return {
    element: bar,
    update: (next) => {
      state = next
      count.textContent = `${next.count} selected`
      bar.hidden = next.count === 0
      if (next.count === 0) {
        statusMenu.close()
        priorityMenu.close()
      }
      statusMenu.refresh()
    },
  }
}

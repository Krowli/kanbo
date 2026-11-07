import { el } from './dom'

/**
 * A small panel that opens under a button: Filter and Display. It opens on a
 * click and closes on a second click, a click outside and Escape, taking the
 * focus in when it opens and back to its button when it closes. Only one is
 * open at a time.
 */

export interface PopoverHandle {
  isOpen: () => boolean
  open: () => void
  close: () => void
  /** Build the content again, keeping the focus on the same control (by `data-key`) while it is open. */
  refresh: () => void
}

let current: PopoverHandle | null = null

/** Whether any popover is open, for the keys that must leave the page alone while one is. */
export function isPopoverOpen(): boolean {
  return current?.isOpen() ?? false
}

/** Close whichever popover is open, giving the focus back to its button; `false` when none was open. */
export function closeOpenPopover(): boolean {
  if (!current?.isOpen()) {
    return false
  }
  current.close()
  return true
}

/**
 * Make `trigger` open a popover whose content `build` makes. The popover is
 * added after the trigger inside `anchor`, a positioned wrapper.
 */
export function attachPopover(
  anchor: HTMLElement,
  trigger: HTMLButtonElement,
  label: string,
  build: () => HTMLElement,
  align: 'start' | 'end' = 'start',
): PopoverHandle {
  let panel: HTMLElement | null = null
  trigger.setAttribute('aria-haspopup', 'dialog')
  trigger.setAttribute('aria-expanded', 'false')

  const onPointerDown = (event: Event): void => {
    if (panel && !panel.contains(event.target as Node) && !trigger.contains(event.target as Node)) {
      close(false)
    }
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      close(true)
    }
  }

  function open(): void {
    if (panel) {
      return
    }
    if (current && current !== handle) {
      current.close()
    }
    panel = el('div', 'popover')
    panel.setAttribute('role', 'dialog')
    panel.setAttribute('aria-label', label)
    panel.dataset.align = align
    panel.append(...build().children)
    anchor.append(panel)
    trigger.setAttribute('aria-expanded', 'true')
    current = handle
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    panel.querySelector<HTMLElement>('input, button')?.focus()
  }

  function close(returnFocus: boolean): void {
    if (!panel) {
      return
    }
    panel.remove()
    panel = null
    trigger.setAttribute('aria-expanded', 'false')
    document.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('keydown', onKeyDown, true)
    if (current === handle) {
      current = null
    }
    if (returnFocus) {
      trigger.focus()
    }
  }

  const handle: PopoverHandle = {
    isOpen: () => panel !== null,
    open,
    close: () => close(true),
    refresh: () => {
      if (!panel) {
        return
      }
      const focusedKey = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-key]')?.dataset.key
      panel.replaceChildren(...build().children)
      if (focusedKey !== undefined) {
        panel.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusedKey)}"]`)?.focus()
      }
    },
  }
  trigger.addEventListener('click', () => (panel ? close(true) : open()))
  return handle
}

// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'

import { button, el } from './dom'
import { attachPopover, closeOpenPopover, isPopoverOpen } from './popover'

function setup(build?: () => HTMLElement) {
  const anchor = el('span', 'anchor')
  const trigger = button('Filter', 'tool-button', () => {})
  anchor.append(trigger)
  document.body.append(anchor)
  const handle = attachPopover(anchor, trigger, 'Filter cards', build ?? (() => {
    const content = el('div')
    const input = el('input')
    input.type = 'checkbox'
    input.dataset.key = 'one'
    content.append(input)
    return content
  }))
  return { anchor, trigger, handle }
}

afterEach(() => {
  closeOpenPopover()
  document.body.replaceChildren()
})

describe('attachPopover', () => {
  it('opens on a click as a labelled dialog, moves the focus in, and closes on a second click', () => {
    const { anchor, trigger } = setup()
    trigger.click()
    const dialog = anchor.querySelector('.popover')
    expect(dialog?.getAttribute('role')).toBe('dialog')
    expect(dialog?.getAttribute('aria-label')).toBe('Filter cards')
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(dialog?.querySelector('input'))
    trigger.click()
    expect(anchor.querySelector('.popover')).toBeNull()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('closes on Escape and gives the focus back to its button', () => {
    const { anchor, trigger } = setup()
    trigger.click()
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(anchor.querySelector('.popover')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('closes on a click outside, and stays open on a click inside', () => {
    const { anchor, trigger } = setup()
    trigger.click()
    anchor.querySelector('input')?.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(anchor.querySelector('.popover')).not.toBeNull()
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(anchor.querySelector('.popover')).toBeNull()
  })

  it('keeps only one open, and says whether any is', () => {
    const first = setup()
    const second = setup()
    first.trigger.click()
    expect(isPopoverOpen()).toBe(true)
    second.trigger.click()
    expect(first.anchor.querySelector('.popover')).toBeNull()
    expect(second.anchor.querySelector('.popover')).not.toBeNull()
    expect(closeOpenPopover()).toBe(true)
    expect(isPopoverOpen()).toBe(false)
    expect(closeOpenPopover()).toBe(false)
  })

  it('builds the content again on refresh and keeps the focus on the same control', () => {
    let round = 0
    const { anchor, trigger, handle } = setup(() => {
      round += 1
      const content = el('div')
      const input = el('input')
      input.type = 'checkbox'
      input.dataset.key = 'one'
      input.title = `round ${round}`
      content.append(input)
      return content
    })
    trigger.click()
    handle.refresh()
    const input = anchor.querySelector('input')
    expect(input?.title).toBe('round 2')
    expect(document.activeElement).toBe(input)
  })
})

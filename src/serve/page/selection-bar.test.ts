// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

import { statusFixture } from './fixtures'
import { closeOpenPopover } from './popover'
import { createSelectionBar } from './selection-bar'

const statuses = [
  statusFixture({ id: 'todo', name: 'To Do' }),
  statusFixture({ id: 'doing', name: 'Doing', category: 'started' }),
  statusFixture({ id: 'no', name: 'Canceled', category: 'canceled' }),
]

function setup(count = 2) {
  const actions = { onMove: vi.fn(), onPriority: vi.fn(), onClear: vi.fn() }
  const bar = createSelectionBar(actions)
  document.body.append(bar.element)
  bar.update({ count, statuses })
  const find = (text: string) => [...bar.element.querySelectorAll('button')].find(item => item.textContent?.trim().startsWith(text))!
  return { bar, actions, find }
}

afterEach(() => {
  closeOpenPopover()
  document.body.replaceChildren()
})

describe('createSelectionBar', () => {
  it('is hidden with nothing selected, and says how many are selected otherwise', () => {
    const { bar } = setup(0)
    expect(bar.element.hidden).toBe(true)
    bar.update({ count: 3, statuses })
    expect(bar.element.hidden).toBe(false)
    expect(bar.element.querySelector('.selection-count')?.textContent).toBe('3 selected')
    expect(bar.element.getAttribute('role')).toBe('toolbar')
  })

  it('moves the selected cards to the column chosen from Status', () => {
    const { bar, actions, find } = setup()
    find('Status').click()
    const options = [...bar.element.querySelectorAll<HTMLButtonElement>('.popover button')]
    expect(options.map(option => option.textContent)).toEqual(['To Do', 'Doing', 'Canceled'])
    options[1]!.click()
    expect(actions.onMove).toHaveBeenCalledWith('doing')
    expect(bar.element.querySelector('.popover')).toBeNull()
  })

  it('sets the priority chosen from Priority on the selected cards', () => {
    const { bar, actions, find } = setup()
    find('Priority').click()
    const high = [...bar.element.querySelectorAll<HTMLButtonElement>('.popover button')].find(option => option.textContent === 'High')!
    high.click()
    expect(actions.onPriority).toHaveBeenCalledWith('high')
  })

  it('clears the selection from the cross', () => {
    const { bar, actions } = setup()
    bar.element.querySelector<HTMLButtonElement>('button.selection-clear')?.click()
    expect(actions.onClear).toHaveBeenCalled()
  })

  it('keeps an open menu open while the count changes', () => {
    const { bar, find } = setup()
    find('Status').click()
    bar.update({ count: 3, statuses })
    expect(bar.element.querySelector('.popover')).not.toBeNull()
  })
})

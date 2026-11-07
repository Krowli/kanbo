// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

import type { ServeCardView } from '../views'
import { renderCard } from './card-element'
import { cardFixture, statusFixture } from './fixtures'
import { subtaskBlock } from './subtasks'

const running: ServeCardView['activeRun'] = { id: 'run', agentId: null, agentName: 'claude', state: 'running', branch: null, executionMode: 'main', chatSessionId: null, startedAt: 0 }

describe('renderCard', () => {
  it('shows a title written as HTML as its characters, and runs nothing', () => {
    const title = '<img src=x onerror=alert(1)>'
    const card = renderCard(cardFixture({ id: 'WOR-001', title, statusLine: '<b>bold</b>' }), 'started', () => {})
    expect(card.querySelector('img')).toBeNull()
    expect(card.querySelector('b')).toBeNull()
    expect(card.querySelector('.card-title')?.textContent).toBe(title)
    expect(card.querySelector('.status-line')?.textContent).toBe('<b>bold</b>')
  })

  it('titles a card named by its key with the first line of its description', () => {
    const card = renderCard(cardFixture({ id: 'WOR-001', title: 'WOR-001', description: '## Fix the race\nmore' }), null, () => {})
    expect(card.querySelector('.card-title')?.textContent).toBe('Fix the race')
  })

  it('reads top to bottom: meta, title, status row, footer', () => {
    const card = renderCard(cardFixture({
      id: 'WOR-001',
      statusLine: 'writing the routes',
      waitingFor: 'human',
      attemptCount: 2,
      priority: 'high',
      labels: ['email'],
      delegateAgentId: 'claude',
    }), 'started', () => {})
    expect([...card.children].map(row => row.className)).toEqual(['card-meta', 'card-title', 'card-status', 'card-footer'])
    expect(card.querySelector('.card-meta .card-key')?.textContent).toBe('WOR-001')
    expect(card.querySelector('.card-meta .avatar')).not.toBeNull()
  })

  it('leaves out a status row and a footer that have nothing in them', () => {
    const card = renderCard(cardFixture({ id: 'WOR-001' }), null, () => {})
    expect([...card.children].map(row => row.className)).toEqual(['card-meta', 'card-title'])
  })

  it('carries the status line with its category, the "Waiting for you" pill and the attempt count', () => {
    const card = renderCard(cardFixture({ id: 'WOR-001', statusLine: 'writing the routes', waitingFor: 'human', attemptCount: 3 }), 'started', () => {})
    expect(card.querySelector<HTMLElement>('.status-line')?.dataset.category).toBe('started')
    expect(card.querySelector<HTMLElement>('.status-line')?.title).toBe('writing the routes')
    expect(card.querySelector('.waiting-pill')?.textContent).toBe('Waiting for you')
    expect(card.querySelector('.waiting-pill svg')?.getAttribute('aria-hidden')).toBe('true')
    expect(card.querySelector('.attempt-chip')?.textContent).toBe('×3')
    expect(renderCard(cardFixture({ id: 'WOR-002', attemptCount: 1 }), null, () => {}).querySelector('.attempt-chip')).toBeNull()
  })

  it('shows the run dot on the avatar only while a run is going, and says who runs it', () => {
    const live = renderCard(cardFixture({ id: 'WOR-001', activeRun: running }), 'started', () => {})
    expect(live.querySelector('.avatar .run-dot')?.getAttribute('aria-hidden')).toBe('true')
    expect(live.querySelector<HTMLElement>('.avatar')?.title).toBe('Running · claude')
    const finished = renderCard(cardFixture({ id: 'WOR-002', delegateAgentId: 'claude', activeRun: { ...running, state: 'finished' } }), 'started', () => {})
    expect(finished.querySelector('.run-dot')).toBeNull()
    expect(finished.querySelector('.avatar')).not.toBeNull()
    expect(renderCard(cardFixture({ id: 'WOR-003' }), null, () => {}).querySelector('.avatar')).toBeNull()
  })

  it('names who works it: an initial for You, a blue square for an agent', () => {
    const agent = renderCard(cardFixture({ id: 'WOR-001', delegateAgentId: 'codex' }), null, () => {})
    expect(agent.querySelector('.avatar')?.textContent).toBe('C')
    expect(agent.querySelector<HTMLElement>('.avatar')?.dataset.kind).toBe('agent')
    const you = renderCard(cardFixture({ id: 'WOR-002', assigneeKind: 'user', assigneeId: '__self__' }), null, () => {})
    expect(you.querySelector('.avatar')?.textContent).toBe('Y')
    expect(you.querySelector<HTMLElement>('.avatar')?.dataset.kind).toBe('user')
    expect(you.querySelector<HTMLElement>('.avatar')?.title).toBe('You')
  })

  it('draws the priority icon for each level and the word, and nothing for none', () => {
    const bars = (priority: ServeCardView['priority']) => renderCard(cardFixture({ id: 'WOR-001', priority }), null, () => {}).querySelectorAll('.priority rect').length
    expect([bars('low'), bars('medium'), bars('high'), bars('urgent')]).toEqual([1, 2, 3, 4])
    const urgent = renderCard(cardFixture({ id: 'WOR-001', priority: 'urgent' }), null, () => {})
    expect(urgent.querySelector('.priority')?.textContent).toBe('Urgent')
    expect(urgent.querySelector<HTMLElement>('.priority')?.dataset.priority).toBe('urgent')
    expect(renderCard(cardFixture({ id: 'WOR-002' }), null, () => {}).querySelector('.priority')).toBeNull()
  })

  it('shows two labels and "+n" for the rest, with labels written as HTML as their characters', () => {
    const card = renderCard(cardFixture({ id: 'WOR-001', labels: ['<b>x</b>', 'email', 'ui', 'db'] }), null, () => {})
    expect(card.querySelector('b')).toBeNull()
    expect([...card.querySelectorAll('.label')].map(label => label.textContent)).toEqual(['<b>x</b>', 'email'])
    expect(card.querySelector('.label-more')?.textContent).toBe('+2')
    expect(card.querySelector<HTMLElement>('.label-more')?.title).toBe('ui, db')
  })

  it('gives the same label the same tone on every card', () => {
    const tone = (id: string) => renderCard(cardFixture({ id, labels: ['frontend'] }), null, () => {}).querySelector<HTMLElement>('.label')?.dataset.tone
    expect(tone('WOR-001')).toBe(tone('WOR-002'))
    expect(tone('WOR-001')).toBeTruthy()
  })

  it('says its state: waiting before running, then done and canceled by column', () => {
    const state = (fields: Partial<ServeCardView>, category: Parameters<typeof renderCard>[1]) =>
      renderCard(cardFixture({ id: 'WOR-001', ...fields }), category, () => {}).dataset.state
    expect(state({ waitingFor: 'human', activeRun: running }, 'started')).toBe('waiting')
    expect(state({ activeRun: running }, 'started')).toBe('running')
    expect(state({}, 'completed')).toBe('done')
    expect(state({}, 'canceled')).toBe('quiet')
    expect(state({}, 'started')).toBe('idle')
    expect(state({}, null)).toBe('idle')
  })

  it('opens from its title button, and is draggable by its id', () => {
    const onOpen = vi.fn()
    const fixture = cardFixture({ id: 'WOR-001', title: 'Quiet', attemptCount: 1 })
    const card = renderCard(fixture, null, onOpen)
    expect(card.draggable).toBe(true)
    expect(card.dataset.cardId).toBe('WOR-001')
    card.querySelector<HTMLButtonElement>('button.card-title')?.click()
    expect(onOpen).toHaveBeenCalledWith(fixture)
  })

  describe('with sub-tasks around it', () => {
    const parent = cardFixture({ id: 'WOR-001', title: 'Ship the thing' })
    const child = cardFixture({ id: 'WOR-002', parentIssueId: 'WOR-001' })
    const context = (fields: Partial<NonNullable<Parameters<typeof renderCard>[3]>> = {}) => ({ parent: null, summary: null, onOpenCard: () => {}, ...fields })

    it('opens with a "Sub-task of" strip naming the parent, which opens the parent alone', () => {
      const onOpen = vi.fn()
      const onOpenCard = vi.fn()
      const card = renderCard(child, 'started', onOpen, context({ parent, onOpenCard }))
      const strip = card.querySelector<HTMLButtonElement>('button.subtask-strip')
      expect(strip?.textContent).toBe('Sub-task ofWOR-001Ship the thing')
      expect(strip?.title).toBe('Sub-task of WOR-001 · Ship the thing')
      expect(card.firstElementChild).toBe(strip)
      expect(card.dataset.subtask).toBeDefined()
      strip?.click()
      expect(onOpenCard).toHaveBeenCalledWith('WOR-001')
      expect(onOpen).not.toHaveBeenCalled()
    })

    it('shows a parent that is not on the board as its key alone, not clickable', () => {
      const card = renderCard(child, null, () => {}, context())
      expect(card.querySelector('button.subtask-strip')).toBeNull()
      expect(card.querySelector('.subtask-strip')?.textContent).toBe('Sub-task ofWOR-001')
    })

    it('shows a parent title written as HTML as its characters', () => {
      const title = '<img src=x onerror=alert(1)>'
      const card = renderCard(child, null, () => {}, context({ parent: { ...parent, title } }))
      expect(card.querySelector('img')).toBeNull()
      expect(card.querySelector('.subtask-strip .strip-title')?.textContent).toBe(title)
    })

    it('says how far the sub-tasks are with a bar and "x/y done"', () => {
      const card = renderCard(parent, null, () => {}, context({ summary: { total: 3, done: 2 } }))
      expect(card.querySelector('.progress-text')?.textContent).toBe('2/3 done')
      expect(card.querySelector<HTMLProgressElement>('progress')?.value).toBe(2)
      expect(card.querySelector<HTMLProgressElement>('progress')?.max).toBe(3)
      expect(card.querySelector<HTMLElement>('.progress-text')?.title).toBe('2 of 3 sub-tasks done')
    })

    it('adds nothing without a context', () => {
      const card = renderCard(child, null, () => {})
      expect(card.querySelector('.subtask-strip')).toBeNull()
      expect(card.querySelector('.progress')).toBeNull()
    })
  })

  describe('with its sub-tasks inside it', () => {
    const statuses = [statusFixture({ id: 'todo', name: 'To Do' }), statusFixture({ id: 'doing', name: 'Doing', category: 'started' }), statusFixture({ id: 'done', name: 'Done', category: 'completed' })]
    const parent = cardFixture({ id: 'WOR-001', title: 'Ship the thing' })
    const part = (id: string, statusId: string, fields: Partial<ServeCardView> = {}) => cardFixture({ id, statusId, parentIssueId: 'WOR-001', ...fields })
    const build = (children: ServeCardView[], faded: string[] = [], extra: Partial<NonNullable<Parameters<typeof renderCard>[3]>> = {}) => {
      const cards = [parent, ...children]
      const block = subtaskBlock(cards, statuses, 'WOR-001', new Set(faded))
      const onOpen = vi.fn()
      const onOpenCard = vi.fn()
      const element = renderCard(parent, 'started', onOpen, { parent: null, summary: block?.summary ?? null, onOpenCard, block: block ?? undefined, ...extra })
      return { element, onOpen, onOpenCard }
    }

    it('draws a row per sub-task under the footer: its column icon, key, title, and a bar with "x/y done"', () => {
      const { element } = build([part('WOR-002', 'todo', { title: 'Design' }), part('WOR-003', 'done', { title: 'Build' })])
      expect([...element.children].map(row => row.className)).toEqual(['card-meta', 'card-title', 'subtask-block'])
      const rows = [...element.querySelectorAll('.subtask-row')]
      expect(rows.map(row => row.querySelector('.card-key')?.textContent)).toEqual(['WOR-002', 'WOR-003'])
      expect(rows.map(row => row.querySelector('.row-title')?.textContent)).toEqual(['Design', 'Build'])
      expect(rows.map(row => row.querySelector<HTMLElement>('.status-icon')?.dataset.category)).toEqual(['unstarted', 'completed'])
      expect(element.querySelector('.subtask-block .progress-text')?.textContent).toBe('1/2 done')
      expect(element.querySelectorAll('.subtask-block .progress')).toHaveLength(1)
    })

    it('opens a sub-task from its row, and not the parent', () => {
      const { element, onOpen, onOpenCard } = build([part('WOR-002', 'todo')])
      element.querySelector<HTMLButtonElement>('button.subtask-row')?.click()
      expect(onOpenCard).toHaveBeenCalledWith('WOR-002')
      expect(onOpen).not.toHaveBeenCalled()
    })

    it('marks a waiting sub-task, a running one, and one with sub-tasks of its own', () => {
      const run = { id: 'run', agentId: null, agentName: 'claude', state: 'running' as const, branch: null, executionMode: 'main' as const, chatSessionId: null, startedAt: 0 }
      const cards = [parent, part('WOR-002', 'todo', { waitingFor: 'human' }), part('WOR-003', 'doing', { activeRun: run }), part('WOR-004', 'doing'), cardFixture({ id: 'WOR-005', parentIssueId: 'WOR-004' })]
      const block = subtaskBlock(cards, statuses, 'WOR-001', new Set())!
      const element = renderCard(parent, 'started', () => {}, { parent: null, summary: block.summary, onOpenCard: () => {}, block })
      const row = (id: string) => [...element.querySelectorAll('.subtask-row')].find(item => item.querySelector('.card-key')?.textContent === id)!
      expect(row('WOR-002').querySelector('.waiting-pill')?.textContent).toBe('Waiting')
      expect(row('WOR-003').querySelector('.run-dot')).not.toBeNull()
      expect(row('WOR-003').querySelector('.waiting-pill')).toBeNull()
      expect(row('WOR-004').querySelector('.row-count')?.textContent).toBe('0/1')
    })

    it('draws at most five rows and a "+N more" that opens the parent', () => {
      const many = [1, 2, 3, 4, 5, 6, 7].map(n => part(`WOR-10${n}`, 'todo', { order: n }))
      const { element, onOpen } = build(many)
      expect(element.querySelectorAll('.subtask-row')).toHaveLength(5)
      const more = element.querySelector<HTMLButtonElement>('button.subtask-more')
      expect(more?.textContent).toBe('+2 more')
      more?.click()
      expect(onOpen).toHaveBeenCalledWith(parent)
    })

    it('fades the rows that do not match a filter, and shows a long title as text', () => {
      const title = '<img src=x onerror=alert(1)>'
      const { element } = build([part('WOR-002', 'todo', { title }), part('WOR-003', 'todo')], ['WOR-003'])
      expect(element.querySelector('img')).toBeNull()
      expect(element.querySelector('.row-title')?.textContent).toBe(title)
      expect([...element.querySelectorAll<HTMLElement>('.subtask-row')].map(row => row.hasAttribute('data-dim'))).toEqual([false, true])
    })

    it('never hides a sub-task that waits or runs: a pill in the status row and a dot on the avatar', () => {
      const { element } = build([part('WOR-002', 'todo')], [], { waitsBelow: true, runsBelow: true })
      expect(element.querySelector('.card-status .waiting-pill')?.textContent).toBe('Sub-task waiting for you')
      expect(element.querySelector('.card-meta .avatar .run-dot')).not.toBeNull()
      const quiet = build([part('WOR-002', 'todo')]).element
      expect(quiet.querySelector('.card-status')).toBeNull()
      expect(quiet.querySelector('.run-dot')).toBeNull()
    })

    it('has no block in cards mode: only the bar, and the sub-task card wears the strip', () => {
      const element = renderCard(parent, 'started', () => {}, { parent: null, summary: { total: 2, done: 1 }, onOpenCard: () => {} })
      expect(element.querySelector('.subtask-block')).toBeNull()
      expect(element.querySelector('.progress-text')?.textContent).toBe('1/2 done')
    })
  })
})

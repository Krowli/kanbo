// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

import type { ServeCardView } from '../views'
import { renderCard } from './card-element'
import { cardFixture } from './fixtures'

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

  it('carries the status line, the waiting badge, the attempt chip and who is running it, state first', () => {
    const card = renderCard(cardFixture({
      id: 'WOR-001',
      statusLine: 'writing the routes',
      waitingFor: 'human',
      attemptCount: 3,
      activeRun: running,
    }), 'started', () => {})
    expect(card.querySelector<HTMLElement>('.status-line')?.dataset.category).toBe('started')
    expect(card.querySelector('.waiting-badge')?.textContent).toBe('Waiting for you')
    expect(card.querySelector('.attempt-chip')?.textContent).toBe('×3')
    expect(card.querySelector('.run-state')?.textContent).toBe('Running · claude')
    expect(card.querySelector('.run-dot')?.getAttribute('aria-hidden')).toBe('true')
    expect(card.firstElementChild?.className).toBe('card-state')
  })

  it('names who works it — an agent or You — except while the run above already says so', () => {
    const agent = renderCard(cardFixture({ id: 'WOR-001', delegateAgentId: 'codex' }), null, () => {})
    expect(agent.querySelector('.worker')?.textContent).toBe('codex')
    expect(agent.querySelector<HTMLElement>('.worker')?.dataset.kind).toBe('agent')
    const you = renderCard(cardFixture({ id: 'WOR-002', assigneeKind: 'user', assigneeId: '__self__' }), null, () => {})
    expect(you.querySelector('.worker')?.textContent).toBe('You')
    expect(you.querySelector<HTMLElement>('.worker')?.dataset.kind).toBe('user')
    expect(renderCard(cardFixture({ id: 'WOR-003', activeRun: running }), null, () => {}).querySelector('.worker')).toBeNull()
    expect(renderCard(cardFixture({ id: 'WOR-004' }), null, () => {}).querySelector('.worker')).toBeNull()
  })

  it('shows the priority unless it is none, and labels written as HTML as their characters', () => {
    const card = renderCard(cardFixture({ id: 'WOR-001', priority: 'urgent', labels: ['<b>x</b>', 'email'] }), null, () => {})
    expect(card.querySelector<HTMLElement>('.priority')?.dataset.priority).toBe('urgent')
    expect(card.querySelector('.priority')?.textContent).toBe('urgent')
    expect(card.querySelector('b')).toBeNull()
    expect([...card.querySelectorAll('.label')].map(label => label.textContent)).toEqual(['<b>x</b>', 'email'])
    expect(renderCard(cardFixture({ id: 'WOR-002' }), null, () => {}).querySelector('.card-tags')).toBeNull()
  })

  it('says its state for the coloured edge: waiting before running, then done and canceled by column', () => {
    const state = (fields: Partial<ServeCardView>, category: Parameters<typeof renderCard>[1]) =>
      renderCard(cardFixture({ id: 'WOR-001', ...fields }), category, () => {}).dataset.state
    expect(state({ waitingFor: 'human', activeRun: running }, 'started')).toBe('waiting')
    expect(state({ activeRun: running }, 'started')).toBe('running')
    expect(state({}, 'completed')).toBe('done')
    expect(state({}, 'canceled')).toBe('quiet')
    expect(state({}, 'started')).toBe('idle')
    expect(state({}, null)).toBe('idle')
  })

  it('leaves the state row out of a quiet card, and opens from its title button', () => {
    const onOpen = vi.fn()
    const fixture = cardFixture({ id: 'WOR-001', title: 'Quiet', attemptCount: 1 })
    const card = renderCard(fixture, null, onOpen)
    expect(card.querySelector('.card-state')).toBeNull()
    expect(card.querySelector('.run-dot')).toBeNull()
    card.querySelector<HTMLButtonElement>('button.card-title')?.click()
    expect(onOpen).toHaveBeenCalledWith(fixture)
  })

  describe('with sub-cards around it', () => {
    const parent = cardFixture({ id: 'WOR-001', title: 'Ship the thing' })
    const child = cardFixture({ id: 'WOR-002', parentIssueId: 'WOR-001' })

    it('names the parent on a sub-card, and the parent line opens the parent alone', () => {
      const onOpen = vi.fn()
      const onOpenCard = vi.fn()
      const card = renderCard(child, 'started', onOpen, { parent, summary: null, onOpenCard })
      const link = card.querySelector<HTMLButtonElement>('button.parent-link')
      expect(link?.textContent).toBe('↳ WOR-001Ship the thing')
      link?.click()
      expect(onOpenCard).toHaveBeenCalledWith('WOR-001')
      expect(onOpen).not.toHaveBeenCalled()
      expect(card.firstElementChild).toBe(link)
    })

    it('shows a parent that is not on the board as its key alone, not clickable', () => {
      const card = renderCard(child, null, () => {}, { parent: null, summary: null, onOpenCard: () => {} })
      expect(card.querySelector('button.parent-link')).toBeNull()
      expect(card.querySelector('.parent-link')?.textContent).toBe('↳ WOR-001')
    })

    it('shows a parent title written as HTML as its characters', () => {
      const title = '<img src=x onerror=alert(1)>'
      const card = renderCard(child, null, () => {}, { parent: { ...parent, title }, summary: null, onOpenCard: () => {} })
      expect(card.querySelector('img')).toBeNull()
      expect(card.querySelector('.parent-title')?.textContent).toBe(title)
    })

    it('says how far the sub-cards are, and when all are done', () => {
      const two = renderCard(parent, null, () => {}, { parent: null, summary: { total: 3, done: 2 }, onOpenCard: () => {} })
      expect(two.querySelector('.subcard-chip')?.textContent).toBe('2/3 sub-cards')
      expect(two.querySelector<HTMLElement>('.subcard-chip')?.title).toBe('2 of 3 sub-cards done')
      const all = renderCard(parent, null, () => {}, { parent: null, summary: { total: 3, done: 3 }, onOpenCard: () => {} })
      expect(all.querySelector('.subcard-chip')?.textContent).toBe('All 3 sub-cards done')
    })

    it('adds nothing without a context', () => {
      const card = renderCard(child, null, () => {})
      expect(card.querySelector('.parent-link')).toBeNull()
      expect(card.querySelector('.subcard-chip')).toBeNull()
    })
  })
})

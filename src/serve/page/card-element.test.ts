// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

import { renderCard } from './card-element'
import { cardFixture } from './fixtures'

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

  it('carries the status line, the waiting badge, the attempt chip and the running dot', () => {
    const card = renderCard(cardFixture({
      id: 'WOR-001',
      statusLine: 'writing the routes',
      waitingFor: 'human',
      attemptCount: 3,
      activeRun: { id: 'run', agentId: null, agentName: 'claude', state: 'running', branch: null, executionMode: 'main', chatSessionId: null, startedAt: 0 },
    }), 'started', () => {})
    expect(card.querySelector<HTMLElement>('.status-line')?.dataset.category).toBe('started')
    expect(card.querySelector('.waiting-badge')?.textContent).toBe('Waiting for you')
    expect(card.querySelector('.attempt-chip')?.textContent).toBe('×3')
    expect(card.querySelector('.run-dot')?.getAttribute('aria-label')).toBe('Running: claude')
  })

  it('leaves the status row out of a quiet card, and opens from its title button', () => {
    const onOpen = vi.fn()
    const fixture = cardFixture({ id: 'WOR-001', title: 'Quiet', attemptCount: 1 })
    const card = renderCard(fixture, null, onOpen)
    expect(card.querySelector('.card-status')).toBeNull()
    expect(card.querySelector('.run-dot')).toBeNull()
    card.querySelector<HTMLButtonElement>('button.card-title')?.click()
    expect(onOpen).toHaveBeenCalledWith(fixture)
  })
})

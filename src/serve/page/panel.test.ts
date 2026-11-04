// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

import type { BoardRunView } from '../../ops/runs'
import type { IssueFieldChange } from '../../sqlite/schema'
import type { ServeCommentView } from '../views'
import { activityFixture, cardFixture, statusFixture } from './fixtures'
import type { CardDetail } from './panel'
import { renderPanel } from './panel'

const actions = { close: () => {}, addComment: () => {}, approve: () => {}, returnCard: () => {}, openCard: () => {} }
const text = (value: string) => ({ kind: 'text' as const, text: value })
const nowSeconds = Math.floor(Date.now() / 1000)

function detailFixture(fields: Partial<CardDetail> = {}): CardDetail {
  return {
    card: cardFixture({ id: 'WOR-001' }),
    status: statusFixture({ id: 'todo', name: 'To Do' }),
    comments: [],
    activity: [],
    fieldChanges: [],
    runs: [],
    parent: null,
    children: [],
    statuses: [statusFixture({ id: 'todo', name: 'To Do' })],
    ...fields,
  }
}

describe('renderPanel', () => {
  it('names who works a card while its run is going', () => {
    const card = cardFixture({
      id: 'WOR-001',
      priority: 'high',
      labels: ['email'],
      activeRun: { id: 'run', agentId: null, agentName: 'claude', state: 'running', branch: null, executionMode: 'main', chatSessionId: null, startedAt: 0 },
    })
    const panel = renderPanel(detailFixture({ card }), actions, null)
    const facts = [...panel.querySelectorAll('.facts dt')].map(term => [term.textContent, term.nextElementSibling?.textContent])
    expect(facts).toContainEqual(['Worked by', 'claude · running'])
    expect(facts).toContainEqual(['Column', 'To Do'])
    expect(facts).toContainEqual(['Priority', 'high'])
    expect(facts).toContainEqual(['Labels', 'email'])
  })

  it('says Nobody when nobody works the card, and omits priority none and empty labels', () => {
    const panel = renderPanel(detailFixture(), actions, null)
    const terms = [...panel.querySelectorAll('.facts dt')].map(term => term.textContent)
    expect(terms).toEqual(['Column', 'Created by', 'Worked by'])
    expect(panel.querySelector('.facts')?.textContent).toContain('Nobody')
  })

  it('shows a column move as the old column struck through and the new one inserted', () => {
    const activity = [activityFixture({ id: 's', createdAt: nowSeconds, fieldChange: { action: 'changed-field', field: 'status', fromValue: text('To Do'), toValue: text('In Progress') } })]
    const entry = renderPanel(detailFixture({ activity }), actions, null).querySelector('.history-entry')
    expect(entry?.querySelector('del')?.textContent).toBe('To Do')
    expect(entry?.querySelector('ins')?.textContent).toBe('In Progress')
    expect(entry?.querySelector<HTMLElement>('.actor-chip')?.dataset.kind).toBe('agent')
    expect(entry?.querySelector('time')?.title).not.toBe('')
  })

  it('renders description texts written as HTML as text', () => {
    const activity = [activityFixture({ id: 'row', createdAt: nowSeconds, fieldChange: { action: 'updated-description', field: 'description', fromValue: null, toValue: null } })]
    const fieldChanges = [{ id: 'row', fromValue: '<script>alert(1)</script>', toValue: '<b>new</b>' } as IssueFieldChange]
    const panel = renderPanel(detailFixture({ activity, fieldChanges }), actions, null)
    expect(panel.querySelector('script')).toBeNull()
    expect(panel.querySelector('.history-text-block[data-side="before"]')?.textContent).toBe('Before<script>alert(1)</script>')
    expect(panel.querySelector('.history-text-block[data-side="after"]')?.textContent).toBe('After<b>new</b>')
  })

  it('shows comment and run times short, as History does, with the full time on hover', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 10, 3, 12, 0))
    try {
      const at = (date: Date) => Math.floor(date.getTime() / 1000)
      const older = new Date(2026, 9, 31, 17, 20)
      const comments = [
        { id: 'c1', content: 'hi', createdAt: at(new Date(2026, 10, 3, 11, 55)), author: { kind: 'user', id: '__self__', displayName: 'You', avatarUrl: null, label: null } },
        { id: 'c2', content: 'older', createdAt: at(older), author: { kind: 'agent', id: 'claude', displayName: 'claude', avatarUrl: null, label: null } },
      ] as ServeCommentView[]
      const runs = [{ id: 'r1', attempt: 1, agentName: 'claude', state: 'failed', branch: null, startedAt: at(older) }] as BoardRunView[]
      const panel = renderPanel(detailFixture({ comments, runs }), actions, null)
      const times = [...panel.querySelectorAll<HTMLTimeElement>('.entries time')]
      const day = older.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
      const clock = older.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      expect(times.map(time => time.textContent)).toEqual(['5 min ago', `${day} ${clock}`, `${day} ${clock}`])
      expect(times[1].title).toBe(older.toLocaleString())
      expect(times[1].dateTime).toBe(older.toISOString())
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('keeps comments out of History and says so when it is empty', () => {
    const activity = [activityFixture({ id: 'k', kind: 'comment', comment: { content: 'only a comment', systemKind: null } })]
    const panel = renderPanel(detailFixture({ activity }), actions, null)
    expect(panel.querySelector('.history-entry')).toBeNull()
    expect(panel.textContent).toContain('No history yet.')
    expect(panel.textContent).not.toContain('only a comment')
  })

  describe('sub-cards', () => {
    const parent = cardFixture({ id: 'WOR-000', title: 'The whole job' })
    const statuses = [
      statusFixture({ id: 'todo', name: 'To Do' }),
      statusFixture({ id: 'done', name: 'Done', category: 'completed' }),
    ]
    const children = [
      cardFixture({ id: 'WOR-002', statusId: 'todo', parentIssueId: 'WOR-001', waitingFor: 'human' }),
      cardFixture({ id: 'WOR-003', statusId: 'done', parentIssueId: 'WOR-001', title: '<img src=x onerror=alert(1)>' }),
    ]

    it('shows a Parent row that opens the parent', () => {
      const openCard = vi.fn()
      const card = cardFixture({ id: 'WOR-001', parentIssueId: 'WOR-000' })
      const panel = renderPanel(detailFixture({ card, parent }), { ...actions, openCard }, null)
      const link = panel.querySelector<HTMLButtonElement>('.facts button.link')
      expect(link?.textContent).toContain('The whole job')
      link?.click()
      expect(openCard).toHaveBeenCalledWith('WOR-000')
    })

    it('lists the sub-cards with their columns, a waiting badge, and opens one on click', () => {
      const openCard = vi.fn()
      const panel = renderPanel(detailFixture({ children, statuses }), { ...actions, openCard }, null)
      const section = panel.querySelector('.subcards')?.closest('section')
      expect(section?.querySelector('h3')?.textContent).toBe('Sub-cards · 1 of 2 done')
      const rows = [...panel.querySelectorAll<HTMLButtonElement>('.subcards button.subcard')]
      expect(rows.map(row => row.querySelector('.subcard-column')?.textContent)).toEqual(['To Do', 'Done'])
      expect(rows[0]?.querySelector('.waiting-badge')?.textContent).toBe('Waiting for you')
      expect(rows[1]?.querySelector('.waiting-badge')).toBeNull()
      rows[1]?.click()
      expect(openCard).toHaveBeenCalledWith('WOR-003')
    })

    it('shows a sub-card title written as HTML as its characters', () => {
      const panel = renderPanel(detailFixture({ children, statuses }), actions, null)
      expect(panel.querySelector('img')).toBeNull()
      expect(panel.querySelectorAll('.subcard-title')[1]?.textContent).toBe('<img src=x onerror=alert(1)>')
    })

    it('has no Sub-cards section and no Parent row without them', () => {
      const panel = renderPanel(detailFixture(), actions, null)
      expect(panel.querySelector('.subcards')).toBeNull()
      expect([...panel.querySelectorAll('dt')].map(term => term.textContent)).not.toContain('Parent')
    })
  })
})

describe('an outside writer in the panel', () => {
  it('is shown as an agent by its name, without the External suffix', () => {
    const actor = { kind: 'system' as const, id: 'claude', displayName: 'claude', avatarUrl: null, label: 'External' }
    const activity = [activityFixture({ id: 'x', createdAt: nowSeconds, actor, fieldChange: { action: 'changed-field', field: 'status', fromValue: text('To Do'), toValue: text('Done') } })]
    const chip = renderPanel(detailFixture({ activity }), actions, null).querySelector<HTMLElement>('.history-entry .actor-chip')
    expect(chip?.dataset.kind).toBe('agent')
    expect(chip?.textContent).toBe('claude')
    expect(chip?.textContent).not.toContain('External')
    expect(chip?.title).toBe('External')
  })
})

// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

import type { BoardRunView } from '../../ops/runs'
import type { IssueFieldChange } from '../../sqlite/schema'
import type { ServeCommentView } from '../views'
import { activityFixture, cardFixture, statusFixture } from './fixtures'
import type { CardDetail } from './panel'
import { readScroll, renderPanel } from './panel'

const actions = { close: () => {}, addComment: () => {}, approve: () => {}, returnCard: () => {}, openCard: () => {}, selectTab: () => {} }
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
    tab: 'comments',
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
    expect(panel.querySelector('.state-row .column-pill')?.textContent).toBe('To Do')
    expect(facts).toContainEqual(['Priority', 'high'])
    expect(facts).toContainEqual(['Labels', 'email'])
  })

  it('says Nobody when nobody works the card, and omits priority none and empty labels', () => {
    const panel = renderPanel(detailFixture(), actions, null)
    const terms = [...panel.querySelectorAll('.facts dt')].map(term => term.textContent)
    expect(terms).toEqual(['Created by', 'Worked by'])
    expect(panel.querySelector('.facts')?.textContent).toContain('Nobody')
  })

  it('names the agent of the latest run once its run is over', () => {
    const runs = [
      { id: 'r1', attempt: 1, agentName: 'codex', state: 'failed', branch: null, startedAt: 10 },
      { id: 'r2', attempt: 2, agentName: 'claude', state: 'finished', branch: null, startedAt: 20 },
    ] as BoardRunView[]
    const panel = renderPanel(detailFixture({ runs }), actions, null)
    const worked = [...panel.querySelectorAll('.facts dt')].find(term => term.textContent === 'Worked by')?.nextElementSibling
    expect(worked?.textContent).toBe('claude · finished')
    expect(worked?.querySelector<HTMLElement>('.actor-chip')?.dataset.kind).toBe('agent')
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
        { id: 'c2', content: 'older', createdAt: at(older), author: { kind: 'agent', id: 'claude', displayName: 'claude', avatarUrl: null, label: null } },
        { id: 'c1', content: 'hi', createdAt: at(new Date(2026, 10, 3, 11, 55)), author: { kind: 'user', id: '__self__', displayName: 'You', avatarUrl: null, label: null } },
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

describe('the dialog', () => {
  const author = { kind: 'user', id: '__self__', displayName: 'You', avatarUrl: null, label: null }
  const comments = [
    { id: 'c1', content: 'first', createdAt: 1, author },
    { id: 'c2', content: 'second', createdAt: 2, author },
  ] as ServeCommentView[]

  it('is a modal dialog labelled by the title', () => {
    const panel = renderPanel(detailFixture(), actions, null)
    expect(panel.getAttribute('role')).toBe('dialog')
    expect(panel.getAttribute('aria-modal')).toBe('true')
    const title = panel.querySelector('.panel-title')
    expect(title?.id).toBeTruthy()
    expect(panel.getAttribute('aria-labelledby')).toBe(title?.id)
  })

  it('shows the column and the waiting badge in the state row, and no Column fact', () => {
    const card = cardFixture({ id: 'WOR-001', waitingFor: 'human' })
    const panel = renderPanel(detailFixture({ card }), actions, null)
    expect(panel.querySelector('.state-row .column-pill')?.textContent).toBe('To Do')
    expect(panel.querySelector('.state-row .waiting-badge')?.textContent).toBe('Waiting for you')
    expect([...panel.querySelectorAll('.facts dt')].map(term => term.textContent)).not.toContain('Column')
  })

  it('counts the tabs and shows only the selected panel', () => {
    const panel = renderPanel(detailFixture({ comments, tab: 'history' }), actions, null)
    const tabs = [...panel.querySelectorAll<HTMLElement>('[role=tab]')]
    expect(tabs.map(tab => tab.textContent)).toEqual(['Comments2', 'History0', 'Runs0'])
    expect(tabs.map(tab => tab.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false'])
    expect([...panel.querySelectorAll<HTMLElement>('[role=tabpanel]')].map(body => body.hidden)).toEqual([true, false, true])
    expect(tabs[1]?.getAttribute('aria-controls')).toBe(panel.querySelectorAll('[role=tabpanel]')[1]?.id)
  })

  it('selects a tab on click and with the arrow keys', () => {
    const selectTab = vi.fn()
    const panel = renderPanel(detailFixture(), { ...actions, selectTab }, null)
    const tabs = [...panel.querySelectorAll<HTMLElement>('[role=tab]')]
    tabs[2]?.click()
    expect(selectTab).toHaveBeenLastCalledWith('runs')
    tabs[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(selectTab).toHaveBeenLastCalledWith('history')
    tabs[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    expect(selectTab).toHaveBeenLastCalledWith('runs')
  })

  it('puts the composer before the comments, newest first', () => {
    const panel = renderPanel(detailFixture({ comments }), actions, null)
    const form = panel.querySelector('#tab-panel-comments .comment-form')
    const list = panel.querySelector('#tab-panel-comments .entries')
    expect(form?.nextElementSibling).toBe(list)
    expect([...panel.querySelectorAll('#tab-panel-comments .entry-text')].map(text => text.textContent)).toEqual(['second', 'first'])
  })

  it('closes from the labelled cross', () => {
    const close = vi.fn()
    const cross = renderPanel(detailFixture(), { ...actions, close }, null).querySelector<HTMLButtonElement>('.panel-head button')
    expect(cross?.getAttribute('aria-label')).toBe('Close')
    cross?.click()
    expect(close).toHaveBeenCalled()
  })

  it('reads the scroll of the same card before its dialog leaves the document', () => {
    const host = document.createElement('div')
    document.body.append(host)
    host.append(renderPanel(detailFixture(), actions, null))
    const scroller = host.querySelector<HTMLElement>('.panel-scroll')!
    scroller.scrollTop = 120
    const top = readScroll(host, 'WOR-001')
    expect(readScroll(host, 'WOR-002')).toBe(0)
    host.replaceChildren()
    expect(top).toBe(120)
    host.remove()
  })

  it('switches tabs in place: the composer node and its text stay', () => {
    const selectTab = vi.fn()
    const panel = renderPanel(detailFixture(), { ...actions, selectTab }, null)
    document.body.append(panel)
    const composer = panel.querySelector<HTMLTextAreaElement>('.comment-form textarea')!
    composer.value = 'half-written'
    const tabs = [...panel.querySelectorAll<HTMLElement>('[role=tab]')]
    tabs[2]?.click()
    expect(panel.querySelector<HTMLElement>('#tab-panel-runs')?.hidden).toBe(false)
    expect(panel.querySelector<HTMLElement>('#tab-panel-comments')?.hidden).toBe(true)
    tabs[0]?.click()
    expect(selectTab.mock.calls).toEqual([['runs'], ['comments']])
    expect(document.body.contains(composer)).toBe(true)
    expect(panel.querySelector('.comment-form textarea')).toBe(composer)
    expect(composer.value).toBe('half-written')
    expect(tabs.map(tab => tab.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false'])
    panel.remove()
  })

  it('moves focus to the neighbouring tab on an arrow key', () => {
    const panel = renderPanel(detailFixture(), actions, null)
    document.body.append(panel)
    const tabs = [...panel.querySelectorAll<HTMLElement>('[role=tab]')]
    tabs[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(document.activeElement).toBe(tabs[1])
    panel.remove()
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

  it('is shown with the agent look in the comments too', () => {
    const author = { kind: 'system' as const, id: 'claude', displayName: 'claude', avatarUrl: null, label: 'External' }
    const comments = [{ id: 'c1', issueId: 'WOR-001', authorKind: 'system', authorId: 'claude', sourceChatSessionId: null, content: 'done', createdAt: nowSeconds, author }] as unknown as ServeCommentView[]
    const chip = renderPanel(detailFixture({ comments }), actions, null).querySelector<HTMLElement>('.entries .actor-chip')
    expect(chip?.dataset.kind).toBe('agent')
    expect(chip?.textContent).toBe('claude')
  })
})

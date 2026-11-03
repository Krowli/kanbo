// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'

import type { IssueFieldChange } from '../../sqlite/schema'
import { activityFixture, cardFixture, statusFixture } from './fixtures'
import type { CardDetail } from './panel'
import { renderPanel } from './panel'

const actions = { close: () => {}, addComment: () => {}, approve: () => {}, returnCard: () => {} }
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

  it('keeps comments out of History and says so when it is empty', () => {
    const activity = [activityFixture({ id: 'k', kind: 'comment', comment: { content: 'only a comment', systemKind: null } })]
    const panel = renderPanel(detailFixture({ activity }), actions, null)
    expect(panel.querySelector('.history-entry')).toBeNull()
    expect(panel.textContent).toContain('No history yet.')
    expect(panel.textContent).not.toContain('only a comment')
  })
})

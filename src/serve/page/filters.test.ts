import { describe, expect, it } from 'vitest'

import type { CardFilters } from './filters'
import { cardWorker, filterOptions, isFiltering, matchesFilters, NO_FILTERS, readFilters, writeFilters } from './filters'
import { cardFixture } from './fixtures'

const run = (state: string, agentName = 'claude') => ({ id: 'run', agentId: null, agentName, state, branch: null, executionMode: 'main', chatSessionId: null, startedAt: 0 }) as never
const only = (filters: Partial<CardFilters>): CardFilters => ({ ...NO_FILTERS, ...filters })

describe('filters', () => {
  it('no filters match every card and are not filtering', () => {
    expect(matchesFilters(cardFixture({ id: 'A-1' }), NO_FILTERS)).toBe(true)
    expect(isFiltering(NO_FILTERS)).toBe(false)
  })

  it('matches text in key, title, description, status line and label, ignoring case; blank text matches all', () => {
    const card = cardFixture({ id: 'WOR-001', title: 'Title', description: 'Describes', statusLine: 'Writing', labels: ['Backend'] })
    for (const text of ['wor-001', 'TITLE', 'describ', 'writ', 'backe', '  title ']) {
      expect(matchesFilters(card, only({ text }))).toBe(true)
    }
    expect(matchesFilters(card, only({ text: 'nope' }))).toBe(false)
    expect(matchesFilters(card, only({ text: '   ' }))).toBe(true)
    expect(isFiltering(only({ text: '   ' }))).toBe(false)
  })

  it('names the worker: running run, then delegate, then assignee; a finished run is ignored', () => {
    expect(cardWorker(cardFixture({ id: 'A', activeRun: run('running', 'codex'), delegateAgentId: 'd', assigneeKind: 'user' }))).toEqual({ key: 'agent:codex', label: 'codex' })
    expect(cardWorker(cardFixture({ id: 'A', activeRun: run('completed'), delegateAgentId: 'd', assigneeKind: 'user' }))).toEqual({ key: 'agent:d', label: 'd' })
    expect(cardWorker(cardFixture({ id: 'A', assigneeKind: 'user' }))).toEqual({ key: 'user', label: 'You' })
    expect(cardWorker(cardFixture({ id: 'A', assigneeKind: 'agent', assigneeId: 'x' }))).toEqual({ key: 'agent:x', label: 'x' })
    expect(cardWorker(cardFixture({ id: 'A' }))).toBeNull()
  })

  it('"nobody" keeps only cards without a worker; a key keeps that worker', () => {
    const mine = cardFixture({ id: 'A', assigneeKind: 'user' })
    const free = cardFixture({ id: 'B' })
    expect([mine, free].filter(card => matchesFilters(card, only({ worker: 'nobody' })))).toEqual([free])
    expect([mine, free].filter(card => matchesFilters(card, only({ worker: 'user' })))).toEqual([mine])
  })

  it('toggles waiting and running', () => {
    const waiting = cardFixture({ id: 'A', waitingFor: 'human' })
    const running = cardFixture({ id: 'B', activeRun: run('running') })
    expect(matchesFilters(waiting, only({ waiting: true }))).toBe(true)
    expect(matchesFilters(running, only({ waiting: true }))).toBe(false)
    expect(matchesFilters(running, only({ running: true }))).toBe(true)
    expect(matchesFilters(cardFixture({ id: 'C', activeRun: run('completed') }), only({ running: true }))).toBe(false)
  })

  it('takes any of the priorities and any of the labels, and both together', () => {
    const card = cardFixture({ id: 'A', priority: 'high', labels: ['x', 'y'] })
    expect(matchesFilters(card, only({ priorities: ['urgent', 'high'] }))).toBe(true)
    expect(matchesFilters(card, only({ priorities: ['low'] }))).toBe(false)
    expect(matchesFilters(card, only({ labels: ['z', 'y'] }))).toBe(true)
    expect(matchesFilters(card, only({ priorities: ['high'], labels: ['z'] }))).toBe(false)
  })

  it('lists each worker and label once, sorted', () => {
    const options = filterOptions([
      cardFixture({ id: 'A', labels: ['b', 'a'], delegateAgentId: 'zed' }),
      cardFixture({ id: 'B', labels: ['a'], delegateAgentId: 'zed' }),
      cardFixture({ id: 'C', assigneeKind: 'user' }),
    ])
    expect(options.labels).toEqual(['a', 'b'])
    expect(options.workers).toEqual([{ key: 'user', label: 'You' }, { key: 'agent:zed', label: 'zed' }])
  })

  it('round-trips through the query string and keeps project', () => {
    const filters: CardFilters = { text: 'a b&c', worker: 'agent:x', waiting: true, running: true, priorities: ['urgent', 'low'], labels: ['p-q', 'r'] }
    const written = writeFilters(filters, '?project=abc')
    expect(written).toContain('project=abc')
    expect(readFilters(written)).toEqual(filters)
    expect(writeFilters(NO_FILTERS, written)).toBe('?project=abc')
    expect(writeFilters(NO_FILTERS, '')).toBe('')
  })

  it('ignores unknown priorities in the address', () => {
    expect(readFilters('?priority=high,bogus').priorities).toEqual(['high'])
  })
})

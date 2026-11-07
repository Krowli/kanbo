// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

import type { BoardMetrics } from '../../ops/board-metrics'
import type { BoardSprint } from '../../ops/sprints'
import type { AnalyticsState } from './analytics'
import {
  createAnalyticsData,
  describeWip,
  formatDuration,
  formatPercent,
  formatThroughput,
  metricsQueryFor,
  personLabel,
  renderAnalytics,
} from './analytics'

const DAY = 86_400

/** A metrics answer built from the package's own type: a field added to or dropped from it fails to compile here. */
const metrics: BoardMetrics = {
  range: { from: 0, to: 12 * 7 * DAY },
  now: 12 * 7 * DAY,
  milestoneId: null,
  columns: [
    { slug: 'backlog', name: 'Backlog', category: 'backlog' },
    { slug: 'todo', name: 'To Do', category: 'unstarted' },
    { slug: 'doing', name: 'In Progress', category: 'started' },
    { slug: 'review', name: 'In Review', category: 'started' },
    { slug: 'done', name: 'Done', category: 'completed' },
  ],
  cycleTime: { cards: 5, p50: 2.6 * DAY, p85: 7 * DAY },
  leadTime: { cards: 5, p50: 3.6 * DAY, p85: 8 * DAY },
  throughput: [
    { week: '2026-W01', start: 0, finished: 1 },
    { week: '2026-W02', start: 7 * DAY, finished: 2 },
    { week: '2026-W03', start: 14 * DAY, finished: 2 },
  ],
  wip: [{ slug: 'doing', cards: 1, limit: 2 }, { slug: 'review', cards: 1, limit: null }],
  aging: [
    { issueId: 'WOR-005', workspaceId: 'w', title: 'Import the old board', slug: 'doing', startedAt: 0, ageSeconds: 20.1 * DAY, inColumnSeconds: 20.1 * DAY, overCycleP85: true },
    { issueId: 'WOR-006', workspaceId: 'w', title: 'Retry a failed push', slug: 'review', startedAt: 0, ageSeconds: 1.1 * DAY, inColumnSeconds: 1.1 * DAY, overCycleP85: false },
  ],
  timeInColumn: [{ slug: 'todo', seconds: 4 * DAY }, { slug: 'doing', seconds: 11.7 * DAY }, { slug: 'review', seconds: 6.5 * DAY }],
  cumulativeFlow: [
    { day: '2026-01-05', at: 0, cards: { backlog: 1, todo: 2, doing: 1, review: 0, done: 0 } },
    { day: '2026-01-06', at: DAY, cards: { backlog: 0, todo: 2, doing: 1, review: 1, done: 1 } },
  ],
  finished: [
    { issueId: 'WOR-001', workspaceId: 'w', title: 'One', startedAt: 0, finishedAt: DAY, cycleSeconds: DAY, leadSeconds: 2 * DAY, returns: 0, runs: 1 },
  ],
  returns: { total: 3, perFinishedCard: 0.6, firstPassRate: 0.4, byActorKind: { user: 1, agent: 1, external: 1 } },
  attempts: { runs: 10, perFinishedCard: 2 },
  canceled: 1,
  agents: [
    { key: 'claude', agentId: null, agentName: 'Claude Code', runs: { total: 6, finished: 5, failed: 0, stopped: 0, running: 1 }, medianRunSeconds: DAY, cardsFinished: 4, returnRate: 0.75 },
    { key: 'gemini', agentId: null, agentName: 'gemini', runs: { total: 1, finished: 0, failed: 0, stopped: 1, running: 0 }, medianRunSeconds: 3600, cardsFinished: 0, returnRate: null },
  ],
  people: [
    { id: '__self__', created: 6, approvals: 2, returns: 1, moves: 8 },
    { id: 'alice', created: 0, approvals: 1, returns: 0, moves: 0 },
  ],
}

const sprint = { id: 'm1', title: 'Sprint 1', cards: { open: 2, done: 3 } } as BoardSprint

const baseState: AnalyticsState = { metrics, sprints: [sprint], loading: false, error: null, query: { weeks: 12, sprint: null } }
const noActions = { onQuery: () => {}, onRetry: () => {}, onOpenCard: () => {} }
const render = (state: Partial<AnalyticsState> = {}, actions = noActions) => renderAnalytics({ ...baseState, ...state }, actions).element

describe('formatting', () => {
  it('writes a duration as hours under a day and days above, "—" for none', () => {
    expect(formatDuration(5 * 3600)).toBe('5h')
    expect(formatDuration(2.6 * DAY)).toBe('2.6d')
    expect(formatDuration(7 * DAY)).toBe('7d')
    expect(formatDuration(20.14 * DAY)).toBe('20.1d')
    expect(formatDuration(1800)).toBe('30m')
    expect(formatDuration(null)).toBe('—')
  })

  it('writes throughput as cards a week, a percent as a whole number', () => {
    expect(formatThroughput(5, 4)).toBe('1.3 a week')
    expect(formatThroughput(4, 2)).toBe('2 a week')
    expect(formatThroughput(0, 0)).toBe('0 a week')
    expect(formatPercent(0.4)).toBe('40%')
    expect(formatPercent(1 / 3)).toBe('33%')
    expect(formatPercent(null)).toBe('—')
  })

  it('names the page\'s own person You and anyone else by id', () => {
    expect(personLabel('__self__')).toBe('You')
    expect(personLabel('alice')).toBe('alice')
    expect(personLabel(null)).toBe('Unknown')
  })

  it('says the work in progress per column with its limit', () => {
    expect(describeWip(metrics)).toBe('In Progress 1/2 · In Review 1')
    expect(describeWip({ ...metrics, wip: [] })).toBe('No started columns')
  })
})

describe('metricsQueryFor', () => {
  // Wednesday 2026-01-14 12:00 UTC; its ISO week starts Monday 2026-01-12.
  const now = Date.UTC(2026, 0, 14, 12) / 1000

  it('sends nothing for the default twelve weeks, and the sprint alone for a sprint', () => {
    expect(metricsQueryFor({ weeks: 12, sprint: null }, now)).toEqual({})
    expect(metricsQueryFor({ weeks: 4, sprint: 'm1' }, now)).toEqual({ sprint: 'm1' })
  })

  it('starts four or twenty-six weeks back on the Monday that makes the range that many ISO weeks long', () => {
    const monday = Date.UTC(2026, 0, 12) / 1000
    expect(metricsQueryFor({ weeks: 4, sprint: null }, now)).toEqual({ from: monday - 3 * 7 * DAY })
    expect(metricsQueryFor({ weeks: 26, sprint: null }, now)).toEqual({ from: monday - 25 * 7 * DAY })
  })
})

describe('the view', () => {
  it('has the pickers: three ranges with the current pressed, and the sprints with "No sprint" first', () => {
    const view = render()
    const ranges = [...view.querySelectorAll<HTMLButtonElement>('.segmented button')]
    expect(ranges.map(item => [item.textContent, item.getAttribute('aria-pressed')])).toEqual([['Last 4 weeks', 'false'], ['Last 12 weeks', 'true'], ['Last 26 weeks', 'false']])
    expect([...view.querySelectorAll('.sprint-select option')].map(option => option.textContent)).toEqual(['No sprint', 'Sprint 1'])
  })

  it('reports a range or sprint chosen, and none of the weeks is pressed while a sprint is', () => {
    const onQuery = vi.fn()
    const view = render({ query: { weeks: 12, sprint: 'm1' } }, { ...noActions, onQuery })
    expect([...view.querySelectorAll('.segmented button')].map(item => item.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'false'])
    view.querySelectorAll<HTMLButtonElement>('.segmented button')[0]!.click()
    expect(onQuery).toHaveBeenLastCalledWith({ weeks: 4, sprint: null })
    const select = view.querySelector<HTMLSelectElement>('.sprint-select select')!
    expect(select.value).toBe('m1')
    select.value = ''
    select.dispatchEvent(new Event('change'))
    expect(onQuery).toHaveBeenLastCalledWith({ weeks: 12, sprint: null })
  })

  it('shows the four figure cards with their values and details', () => {
    const cards = [...render().querySelectorAll('.figure')].map(card => [card.querySelector('.figure-label')?.textContent, card.querySelector('.figure-value')?.textContent, [...card.querySelectorAll('.figure-detail')].map(detail => detail.textContent)])
    expect(cards).toEqual([
      ['Cycle time', 'p50 2.6d · p85 7d', ['Lead time p50 3.6d · p85 8d']],
      ['Throughput', '0.3 a week', ['1 finished']],
      ['In progress now', '2', ['In Progress 1/2 · In Review 1']],
      ['First-pass approval', '40%', ['Returns: 3 (people 1 · agents 1 · outside 1)']],
    ])
    expect(render().querySelector<HTMLElement>('.figure-label')?.title).toContain('p85')
  })

  it('adds "Planned vs done" only for a sprint', () => {
    expect(render().textContent).not.toContain('Planned vs done')
    const withSprint = render({ query: { weeks: 12, sprint: 'm1' } })
    const planned = [...withSprint.querySelectorAll('.figure')].find(card => card.querySelector('.figure-label')?.textContent === 'Planned vs done')
    expect(planned?.querySelector('.figure-value')?.textContent).toBe('3 of 5')
    expect(planned?.querySelector('.figure-detail')?.textContent).toBe('60% done')
  })

  it('draws the three charts, each an image with a name and the same numbers as a hidden table', () => {
    const view = render()
    const titles = [...view.querySelectorAll('.panel-card > h3')].map(title => title.textContent)
    expect(titles).toEqual(['Finished per week', 'Cumulative flow', 'Time in column', 'Aging work', 'Agents', 'People'])
    const images = [...view.querySelectorAll('svg[role="img"]')]
    expect(images).toHaveLength(3)
    expect(images.every(image => (image.getAttribute('aria-label') ?? '') !== '')).toBe(true)
    expect(view.querySelectorAll('table.visually-hidden')).toHaveLength(3)
    expect(view.querySelectorAll('rect.chart-bar')).toHaveLength(3)
    expect(view.querySelector('svg[role="img"][aria-label^="Time in column"]')?.getAttribute('aria-label')).toContain('To Do 4d')
  })

  it('lists the flow legend with the last column first, as the areas are stacked', () => {
    const names = [...render().querySelectorAll('.chart-legend li')].map(item => item.textContent)
    expect(names).toEqual(['Done', 'In Review', 'In Progress', 'To Do', 'Backlog'])
  })

  it('lists the aging cards oldest first, marks those past p85, and opens one on a click', () => {
    const onOpenCard = vi.fn()
    const rows = [...render({}, { ...noActions, onOpenCard }).querySelectorAll<HTMLButtonElement>('.aging-row')]
    expect(rows.map(row => row.querySelector('.card-key')?.textContent)).toEqual(['WOR-005', 'WOR-006'])
    expect(rows[0]!.querySelector('.aging-where')?.textContent).toBe('20.1d in In Progress')
    expect(rows[0]!.querySelector('.aging-age')?.textContent).toBe('20.1d')
    expect(rows.map(row => row.querySelector('.aging-age')?.hasAttribute('data-over'))).toEqual([true, false])
    rows[1]!.click()
    expect(onOpenCard).toHaveBeenCalledWith('WOR-006')
  })

  it('has the agents table with "—" where there is no value, and the people table naming You', () => {
    const view = render()
    const rows = (title: string) => [...[...view.querySelectorAll('.panel-table')].find(panel => panel.querySelector('h3')?.textContent === title)!.querySelectorAll('tbody tr')].map(row => [...row.querySelectorAll('td')].map(cell => cell.textContent))
    expect(rows('Agents')).toEqual([
      ['Claude Code', '6 5 finished · 0 failed · 0 stopped · 1 running', '1d', '4', '75%'],
      ['gemini', '1 0 finished · 0 failed · 1 stopped', '1h', '0', '—'],
    ])
    expect(rows('People')).toEqual([['You', '6', '2', '1', '8'], ['alice', '0', '1', '0', '0']])
  })

  it('ends with the canceled note', () => {
    expect(render().querySelector('.analytics-note')?.textContent).toBe('Canceled in this range: 1. Canceled cards are left out of every other number.')
  })

  it('says nothing finished, and keeps the figures, the aging cards and the tables', () => {
    const view = render({ metrics: { ...metrics, finished: [] } })
    expect(view.querySelector('.analytics-empty h3')?.textContent).toBe('Nothing finished in this range yet')
    expect(view.querySelectorAll('svg[role="img"]')).toHaveLength(0)
    expect(view.querySelectorAll('.figure')).toHaveLength(4)
    expect(view.querySelectorAll('.aging-row')).toHaveLength(2)
    expect(view.querySelectorAll('.panel-table')).toHaveLength(2)
  })

  it('shows skeleton blocks while the first answer is on its way', () => {
    const view = render({ metrics: null, loading: true })
    expect(view.querySelector('.analytics-skeleton')?.getAttribute('aria-busy')).toBe('true')
    expect(view.querySelectorAll('.skeleton').length).toBeGreaterThan(4)
    expect(view.querySelector('svg')).toBeNull()
  })

  it('shows the server\'s message and "Try again" when there is no data to fall back on', () => {
    const onRetry = vi.fn()
    const view = render({ metrics: null, error: 'The range starts after it ends' }, { ...noActions, onRetry })
    expect(view.querySelector('.analytics-error p')?.textContent).toBe('The range starts after it ends')
    view.querySelector<HTMLButtonElement>('.analytics-error button')?.click()
    expect(onRetry).toHaveBeenCalled()
  })

  it('keeps the last numbers on screen under the message when a later load failed', () => {
    const view = render({ error: 'The board server has stopped.' })
    expect(view.querySelector('.analytics-error')?.textContent).toContain('last that loaded')
    expect(view.querySelectorAll('.figure')).toHaveLength(4)
  })

  it('shows a title written as HTML as its characters', () => {
    const title = '<img src=x onerror=alert(1)>'
    const view = render({ metrics: { ...metrics, aging: [{ ...metrics.aging[0]!, title }] } })
    expect(view.querySelector('img')).toBeNull()
    expect(view.querySelector('.aging-title')?.textContent).toBe(title)
  })

  it('has no inline style anywhere', () => {
    expect(render().querySelector('[style]')).toBeNull()
  })
})

describe('createAnalyticsData', () => {
  const setup = () => {
    const api = { metrics: vi.fn(async () => metrics), sprints: vi.fn(async () => [sprint]) }
    const onChange = vi.fn()
    const data = createAnalyticsData(api, () => 'workspace', onChange)
    return { api, onChange, data }
  }
  const settle = async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  }

  it('fetches nothing until the view is shown, however often the board changes', async () => {
    const { api, data } = setup()
    data.boardChanged()
    data.boardChanged()
    await settle()
    expect(api.metrics).not.toHaveBeenCalled()
    expect(api.sprints).not.toHaveBeenCalled()
  })

  it('fetches once when it opens, with the sprints, and holds the answer', async () => {
    const { api, data } = setup()
    data.show({ weeks: 12, sprint: null })
    await settle()
    expect(api.metrics).toHaveBeenCalledTimes(1)
    expect(api.metrics).toHaveBeenCalledWith({})
    expect(api.sprints).toHaveBeenCalledWith('workspace')
    expect(data.state()).toMatchObject({ metrics, sprints: [sprint], loading: false, error: null })
  })

  it('does not fetch again for the same query shown again while it is open', async () => {
    const { api, data } = setup()
    data.show({ weeks: 12, sprint: null })
    await settle()
    data.show({ weeks: 12, sprint: null })
    await settle()
    expect(api.metrics).toHaveBeenCalledTimes(1)
  })

  it('fetches once more for each new version while open, and for a new range', async () => {
    const { api, data } = setup()
    data.show({ weeks: 12, sprint: null })
    await settle()
    data.boardChanged()
    await settle()
    expect(api.metrics).toHaveBeenCalledTimes(2)
    data.show({ weeks: 4, sprint: null })
    await settle()
    expect(api.metrics).toHaveBeenCalledTimes(3)
    expect((api.metrics.mock.calls[2] as unknown[])[0]).toHaveProperty('from')
    data.show({ weeks: 4, sprint: 'm1' })
    await settle()
    expect(api.metrics).toHaveBeenLastCalledWith({ sprint: 'm1' })
  })

  it('fetches nothing once another view is open', async () => {
    const { api, data } = setup()
    data.show({ weeks: 12, sprint: null })
    await settle()
    data.hide()
    data.boardChanged()
    await settle()
    expect(api.metrics).toHaveBeenCalledTimes(1)
  })

  it('keeps the last numbers while a new fetch runs, then replaces them', async () => {
    const { api, data } = setup()
    data.show({ weeks: 12, sprint: null })
    await settle()
    let release: (value: BoardMetrics) => void = () => {}
    api.metrics.mockImplementationOnce(async () => await new Promise<BoardMetrics>((resolve) => {
      release = resolve
    }))
    data.boardChanged()
    expect(data.state()).toMatchObject({ metrics, loading: true })
    release({ ...metrics, canceled: 9 })
    await settle()
    expect(data.state()).toMatchObject({ loading: false })
    expect(data.state().metrics?.canceled).toBe(9)
  })

  it('keeps the last numbers and says why when a fetch fails, and drops an answer the view no longer wants', async () => {
    const { api, data } = setup()
    data.show({ weeks: 12, sprint: null })
    await settle()
    api.metrics.mockRejectedValueOnce(new Error('The board server has stopped.'))
    data.retry()
    await settle()
    expect(data.state()).toMatchObject({ metrics, error: 'The board server has stopped.', loading: false })
    let release: (value: BoardMetrics) => void = () => {}
    api.metrics.mockImplementationOnce(async () => await new Promise<BoardMetrics>((resolve) => {
      release = resolve
    }))
    data.retry()
    data.hide()
    release({ ...metrics, canceled: 7 })
    await settle()
    expect(data.state().metrics?.canceled).toBe(1)
  })

  it('forgets everything when another project is shown', async () => {
    const { data } = setup()
    data.show({ weeks: 12, sprint: null })
    await settle()
    data.reset()
    expect(data.state()).toMatchObject({ metrics: null, sprints: [] })
  })
})

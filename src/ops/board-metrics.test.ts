import { describe, expect, it } from 'vitest'

import { BoardError } from '../domain/errors'
import { day, METRICS_HISTORY, METRICS_INPUT, METRICS_NOW, METRICS_RETURN_COMMENT, METRICS_SPRINT } from '../testing/fixtures/board-metrics'
import type { BoardMetricsHistory } from './board-metrics'
import { boardMetricsRuns, computeBoardMetrics, nearestRank } from './board-metrics'

const metrics = computeBoardMetrics(METRICS_HISTORY, METRICS_INPUT, METRICS_NOW)

function failure(run: () => unknown): BoardError {
  try {
    run()
  }
  catch (error) {
    expect(error).toBeInstanceOf(BoardError)
    return error as BoardError
  }
  throw new Error('expected a BoardError')
}

describe('nearest-rank percentiles', () => {
  it('takes the nearest rank: the ⌈p·n/100⌉-th value in ascending order', () => {
    const twenty = Array.from({ length: 20 }, (_, index) => 20 - index)
    expect(nearestRank(twenty, 85)).toBe(17)
    expect(nearestRank(twenty, 50)).toBe(10)
    expect(nearestRank([5], 85)).toBe(5)
    expect(nearestRank([], 50)).toBeNull()
  })
})

describe('board metrics over a known history', () => {
  it('cuts the range at now', () => {
    expect(metrics.range).toEqual({ from: day(0), to: METRICS_NOW })
    expect(metrics.now).toBe(METRICS_NOW)
  })

  it('times the five cards finished in the range, the reopened one from its first start to its latest finish', () => {
    // Cycle: WOR-008 136 800, WOR-001 172 800, WOR-007 226 799, WOR-002 518 400, WOR-003 604 800.
    // p50 = 3rd of 5, p85 = 5th of 5. Lead: 140 400, 259 200, 313 199, 615 600, 691 200.
    expect(metrics.cycleTime).toEqual({ cards: 5, p50: 226_799, p85: 604_800 })
    expect(metrics.leadTime).toEqual({ cards: 5, p50: 313_199, p85: 691_200 })
    expect(metrics.finished.map(card => [card.issueId, card.startedAt, card.finishedAt, card.returns, card.runs])).toEqual([
      ['WOR-001', day(1, 9), day(3, 9), 0, 1],
      ['WOR-002', day(2, 10), day(8, 10), 1, 3],
      ['WOR-007', day(11, 9), day(14) - 1, 0, 0],
      ['WOR-008', day(12, 10), day(14), 1, 1],
      ['WOR-003', day(7, 12), day(14, 12), 1, 2],
    ])
  })

  it('counts throughput per ISO week, the last second of Sunday and the first of Monday in their own weeks', () => {
    expect(metrics.throughput).toEqual([
      { week: '2026-W01', start: day(0), finished: 1 },
      { week: '2026-W02', start: day(7), finished: 2 },
      { week: '2026-W03', start: day(14), finished: 2 },
      { week: '2026-W04', start: day(21), finished: 0 },
    ])
  })

  it('counts work in progress now against each column\'s limit, and flags the card older than the cycle-time p85', () => {
    expect(metrics.wip).toEqual([
      { slug: 'in_progress', cards: 1, limit: 2 },
      { slug: 'in_review', cards: 1, limit: null },
    ])
    expect(metrics.aging).toEqual([
      { issueId: 'WOR-005', workspaceId: 'workspace', title: 'Card 5', slug: 'in_progress', startedAt: day(4, 9), ageSeconds: 1_738_800, inColumnSeconds: 1_738_800, overCycleP85: true },
      { issueId: 'WOR-006', workspaceId: 'workspace', title: 'Card 6', slug: 'in_review', startedAt: day(21, 9), ageSeconds: 270_000, inColumnSeconds: 97_200, overCycleP85: false },
    ])
  })

  it('sums the finished cards\' time per column up to their finish, the reopened card\'s day in Done included', () => {
    // To Do: 86 400 + 172 800 + 10 800 + 86 400 + (3 600 + 3 600). In Progress: 86 400 + 345 600 + 259 200 + 226 799 + (82 800 + 7 200).
    // In Review: 86 400 + 172 800 + 259 200 + (10 800 + 32 400). Done: WOR-003 from day 9/12 to day 10/12.
    expect(metrics.timeInColumn).toEqual([
      { slug: 'backlog', seconds: 0 },
      { slug: 'to_do', seconds: 363_600 },
      { slug: 'in_progress', seconds: 1_007_999 },
      { slug: 'in_review', seconds: 561_600 },
      { slug: 'done', seconds: 86_400 },
      { slug: 'canceled', seconds: 0 },
    ])
  })

  it('rebuilds the cards per column at the end of each day, the canceled card nowhere', () => {
    const zero = { backlog: 0, to_do: 0, in_progress: 0, in_review: 0, done: 0, canceled: 0 }
    expect(metrics.cumulativeFlow).toHaveLength(25)
    expect(metrics.cumulativeFlow[0]).toEqual({ day: '2025-12-29', at: day(1) - 1, cards: { ...zero, to_do: 2, done: 1 } })
    // Day 4: WOR-004 went to Canceled at 9:00, and is not counted anywhere.
    expect(metrics.cumulativeFlow[4]).toEqual({ day: '2026-01-02', at: day(5) - 1, cards: { ...zero, in_progress: 1, in_review: 1, done: 2 } })
    expect(metrics.cumulativeFlow[9]!.cards).toEqual({ ...zero, in_progress: 1, done: 4 })
    // Day 10: WOR-003 reopened, WOR-007 created.
    expect(metrics.cumulativeFlow[10]!.cards).toEqual({ ...zero, to_do: 1, in_progress: 2, done: 3 })
    // Day 13 is read at its last second, the very moment WOR-007 reached Done.
    expect(metrics.cumulativeFlow[13]).toEqual({ day: '2026-01-11', at: day(14) - 1, cards: { ...zero, in_progress: 1, in_review: 2, done: 4 } })
    // The last day is read at now.
    expect(metrics.cumulativeFlow[24]).toEqual({ day: '2026-01-22', at: METRICS_NOW, cards: { ...zero, in_progress: 1, in_review: 1, done: 6 } })
  })

  it('counts returns, first-pass approval and attempts over the finished cards, and the canceled card apart', () => {
    // Returns: WOR-002 by a person, WOR-003 by an outside kanbo, WOR-008 by the Tester. First pass: WOR-001 and WOR-007 of five.
    expect(metrics.returns).toEqual({ total: 3, perFinishedCard: 0.6, firstPassRate: 0.4, byActorKind: { user: 1, agent: 1, external: 1 } })
    expect(metrics.attempts).toEqual({ runs: 7, perFinishedCard: 1.4 })
    expect(metrics.canceled).toBe(1)
  })

  it('gives each agent its runs in the range, their median, the finished cards it worked and how many came back', () => {
    // claude ended runs: 82 800, 86 400, 86 400, 172 800, 172 800 → 3rd. The canceled card's run is left out.
    // claude worked WOR-001, 002, 003, 008, three of them returned; codex ran WOR-002 (its Tester move on WOR-008 is a move, not a run).
    expect(metrics.agents).toEqual([
      { key: 'agent-claude', agentId: 'agent-claude', agentName: 'claude', runs: { total: 6, finished: 5, failed: 0, stopped: 0, running: 1 }, medianRunSeconds: 86_400, cardsFinished: 4, returnRate: 0.75 },
      { key: 'agent-codex', agentId: 'agent-codex', agentName: 'codex', runs: { total: 3, finished: 2, failed: 1, stopped: 0, running: 0 }, medianRunSeconds: 86_400, cardsFinished: 1, returnRate: 1 },
      { key: 'gemini', agentId: null, agentName: 'gemini', runs: { total: 1, finished: 0, failed: 0, stopped: 1, running: 0 }, medianRunSeconds: 3_600, cardsFinished: 0, returnRate: null },
    ])
  })

  it('gives each person the cards they created, their approvals, returns and moves in the range', () => {
    // Created: WOR-001, 002, 003, 005, 007, 008 (WOR-006 is an agent's, WOR-004 canceled, WOR-009 before the range).
    // Moves: WOR-001 ×1, WOR-002 ×2, WOR-003 ×2, WOR-005 ×1, WOR-007 ×1, WOR-008 ×1; the creations of WOR-007 and 008 are not moves,
    // and WOR-003's reopening is the outside kanbo's. Returns: WOR-002's move back, the person's only one.
    expect(metrics.people).toEqual([
      { id: '__self__', created: 6, approvals: 2, returns: 1, moves: 8 },
      { id: 'alice', created: 0, approvals: 1, returns: 0, moves: 0 },
    ])
  })

  it('gives the same answer whatever order the rows come in', () => {
    const reversed: BoardMetricsHistory = {
      statuses: METRICS_HISTORY.statuses.toReversed(),
      milestones: METRICS_HISTORY.milestones.toReversed(),
      cards: METRICS_HISTORY.cards.toReversed(),
      entries: METRICS_HISTORY.entries.toReversed(),
      runs: METRICS_HISTORY.runs.toReversed(),
      approvals: METRICS_HISTORY.approvals.toReversed(),
    }
    expect(computeBoardMetrics(reversed, METRICS_INPUT, METRICS_NOW)).toEqual(metrics)
  })
})

describe('board metrics of a sprint', () => {
  it('keeps the milestone\'s cards only', () => {
    const sprint = computeBoardMetrics(METRICS_HISTORY, { ...METRICS_INPUT, milestoneId: METRICS_SPRINT.id }, METRICS_NOW)

    // WOR-001, 002, 003: cycle 172 800, 518 400, 604 800; lead 259 200, 615 600, 691 200.
    expect(sprint.cycleTime).toEqual({ cards: 3, p50: 518_400, p85: 604_800 })
    expect(sprint.leadTime).toEqual({ cards: 3, p50: 615_600, p85: 691_200 })
    expect(sprint.throughput.map(week => week.finished)).toEqual([1, 1, 1, 0])
    expect(sprint.wip.map(wip => wip.cards)).toEqual([0, 0])
    expect(sprint.canceled).toBe(0)
    // WOR-002 and WOR-003 came back; WOR-001 did not.
    expect(sprint.returns.firstPassRate).toBeCloseTo(1 / 3)
    expect(sprint.agents.map(agent => [agent.key, agent.runs.total, agent.medianRunSeconds, agent.cardsFinished])).toEqual([
      ['agent-claude', 4, 86_400, 3],
      ['agent-codex', 2, 3_600, 1],
    ])
    expect(sprint.people).toEqual([{ id: '__self__', created: 3, approvals: 2, returns: 1, moves: 5 }])
  })

  it('refuses a milestone of no listed workspace, and a range that starts after it ends', () => {
    expect(failure(() => computeBoardMetrics(METRICS_HISTORY, { ...METRICS_INPUT, milestoneId: 'gone' }, METRICS_NOW)).code)
      .toBe('issue_milestone_not_found')
    expect(failure(() => computeBoardMetrics(METRICS_HISTORY, { ...METRICS_INPUT, workspaceIds: ['other'], milestoneId: METRICS_SPRINT.id }, METRICS_NOW)).code)
      .toBe('issue_milestone_not_found')
    expect(failure(() => computeBoardMetrics(METRICS_HISTORY, { ...METRICS_INPUT, from: day(5), to: day(4) }, METRICS_NOW)).code)
      .toBe('board_metrics_range_invalid')
  })
})

describe('board metrics at the edges', () => {
  it('counts a card created in a started column as started at its creation', () => {
    const created = { ...METRICS_HISTORY.cards[4]!, id: 'WOR-010', number: 10, statusId: 'status-done', createdAt: day(15, 9) }
    const history = { ...METRICS_HISTORY, cards: [...METRICS_HISTORY.cards, created], entries: [...METRICS_HISTORY.entries, {
      changeId: 'change-created', issueId: 'WOR-010', workspaceId: 'workspace', fromStatusId: 'status-progress', toStatusId: 'status-done', actorKind: 'user' as const, actorId: '__self__', at: day(16, 9),
    }] }

    const finished = computeBoardMetrics(history, METRICS_INPUT, METRICS_NOW).finished.find(card => card.issueId === 'WOR-010')

    expect(finished).toMatchObject({ startedAt: day(15, 9), finishedAt: day(16, 9), cycleSeconds: 86_400, leadSeconds: 86_400 })
  })

  it('leaves a column deleted since out of time in column, and still finishes the card', () => {
    // WOR-001 went In Progress → QA (since deleted) at 2/9 → In Review at 2/21: 43 200 s in a column no list has.
    const entries = METRICS_HISTORY.entries.flatMap(entry => entry.issueId === 'WOR-001' && entry.toStatusId === 'status-review'
      ? [{ ...entry, toStatusId: 'status-qa-deleted' }, { ...entry, changeId: 'change-qa', fromStatusId: 'status-qa-deleted', at: day(2, 21) }]
      : [entry])

    const withQa = computeBoardMetrics({ ...METRICS_HISTORY, entries }, METRICS_INPUT, METRICS_NOW)

    expect(withQa.timeInColumn.find(time => time.slug === 'in_review')).toEqual({ slug: 'in_review', seconds: 561_600 - 43_200 })
    expect(withQa.leadTime).toEqual(metrics.leadTime)
  })

  it('reads several workspaces as one board, adding their WIP limits up when each has one', () => {
    const otherProgress = { ...METRICS_HISTORY.statuses[2]!, id: 'other-progress', workspaceId: 'other', name: 'In progress', order: 0, wipLimit: 3 }
    const otherCard = { ...METRICS_HISTORY.cards[4]!, id: 'OTH-001', workspaceId: 'other', number: 1, statusId: 'other-progress', createdAt: day(20) }
    const both = { ...METRICS_INPUT, workspaceIds: ['workspace', 'other'] }
    const history = { ...METRICS_HISTORY, statuses: [...METRICS_HISTORY.statuses, otherProgress], cards: [...METRICS_HISTORY.cards, otherCard] }

    expect(computeBoardMetrics(history, both, METRICS_NOW).wip[0]).toEqual({ slug: 'in_progress', cards: 2, limit: 5 })
    expect(computeBoardMetrics(history, both, METRICS_NOW).columns).toHaveLength(6)
    const unlimited = { ...history, statuses: [...METRICS_HISTORY.statuses, { ...otherProgress, wipLimit: null }] }
    expect(computeBoardMetrics(unlimited, both, METRICS_NOW).wip[0]).toEqual({ slug: 'in_progress', cards: 2, limit: null })
  })

  it('names the runs it counts, and apart those of the canceled card', () => {
    const runs = boardMetricsRuns(METRICS_HISTORY, METRICS_INPUT)

    expect(runs.counted.map(run => run.id)).toEqual([
      'run-01', 'run-02', 'run-03', 'run-04', 'run-05', 'run-06', 'run-08', 'run-09', 'run-10', 'run-11',
    ])
    expect(runs.canceled.map(run => run.id)).toEqual(['run-07'])
  })

  it('counts a person\'s Return once, through its move: the comment beside it adds nothing', () => {
    const withComment = { ...METRICS_HISTORY, approvals: [...METRICS_HISTORY.approvals, METRICS_RETURN_COMMENT] }

    expect(computeBoardMetrics(withComment, METRICS_INPUT, METRICS_NOW).returns).toEqual(metrics.returns)
    expect(computeBoardMetrics(withComment, METRICS_INPUT, METRICS_NOW).people).toEqual(metrics.people)
  })

  it('counts no return for a move back into a column that is neither unstarted nor started', () => {
    // WOR-007 parked in Backlog for an hour on day 12: a move back, but not into To Do or In Progress.
    const entries = METRICS_HISTORY.entries.flatMap(entry => entry.issueId === 'WOR-007' && entry.toStatusId === 'status-done'
      ? [
          { ...entry, changeId: 'change-park', toStatusId: 'status-backlog', at: day(12) },
          { ...entry, changeId: 'change-unpark', fromStatusId: 'status-backlog', toStatusId: 'status-progress', at: day(12, 1) },
          entry,
        ]
      : [entry])

    const parked = computeBoardMetrics({ ...METRICS_HISTORY, entries }, METRICS_INPUT, METRICS_NOW)

    expect(parked.finished.find(card => card.issueId === 'WOR-007')?.returns).toBe(0)
    expect(parked.returns.total).toBe(3)
  })
})

describe('board metrics fix round 1', () => {
  it('gives empty series for a range that starts after now (R012-11)', () => {
    const later = computeBoardMetrics(METRICS_HISTORY, { ...METRICS_INPUT, from: METRICS_NOW + 3_600 }, METRICS_NOW)

    expect(later.throughput).toEqual([])
    expect(later.cumulativeFlow).toEqual([])
  })

  it('names an agent the same whichever order two same-second runs come in', () => {
    const first = { ...METRICS_HISTORY.runs[0]!, id: 'run-a', agentId: 'agent-x', agentName: 'x-old', startedAt: day(3) }
    const second = { ...first, id: 'run-b', agentName: 'x-new' }
    const nameFor = (runs: typeof METRICS_HISTORY.runs) =>
      computeBoardMetrics({ ...METRICS_HISTORY, runs }, METRICS_INPUT, METRICS_NOW).agents.find(agent => agent.key === 'agent-x')?.agentName

    expect(nameFor([first, second])).toBe(nameFor([second, first]))
  })
})

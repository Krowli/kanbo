import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TestBoardStore } from '../testing/board-stores'
import { BOARD_STORE_FACTORIES } from '../testing/board-stores'
import { METRICS_HISTORY, METRICS_INPUT, METRICS_NOW, METRICS_RETURN_COMMENT, METRICS_WORKSPACE, writeMetricsHistory } from '../testing/fixtures/board-metrics'
import { computeBoardMetrics } from './board-metrics'
import { boardMetrics, readBoardMetricsHistory } from './board-metrics-read'
import { createCard, moveCard } from './cards'
import { ensureDefaultColumns, removeColumn } from './columns'
import type { BoardActor } from './types'

describe.each(BOARD_STORE_FACTORIES)('board metrics on $name', (factory) => {
  let board: TestBoardStore

  beforeEach(async () => {
    board = await factory.open([{ id: METRICS_WORKSPACE, identifier: 'WOR' }, { id: 'other', identifier: 'OTH' }])
    await writeMetricsHistory(board.store, METRICS_HISTORY)
    // On a real board a person's Return leaves this comment beside its move; the read must not count it.
    await board.store.comments.create(METRICS_RETURN_COMMENT)
  })

  afterEach(async () => {
    await board.dispose()
  })

  it('reads back the rows it was written and answers what the rows answer', async () => {
    const metrics = await boardMetrics(board.store, METRICS_INPUT, METRICS_NOW)

    expect(metrics).toEqual(computeBoardMetrics(METRICS_HISTORY, METRICS_INPUT, METRICS_NOW))
    expect(metrics.cycleTime).toEqual({ cards: 5, p50: 226_799, p85: 604_800 })
    expect(metrics.canceled).toBe(1)
  })

  it('reads nothing of a workspace it was not asked about', async () => {
    expect(await readBoardMetricsHistory(board.store, ['other']))
      .toEqual({ statuses: [], milestones: [], cards: [], entries: [], runs: [], approvals: [] })
    expect(await readBoardMetricsHistory(board.store, []))
      .toEqual({ statuses: [], milestones: [], cards: [], entries: [], runs: [], approvals: [] })
  })
})

describe.each(BOARD_STORE_FACTORIES)('board metrics of cards written through the operations on $name', (factory) => {
  const workspace = { id: 'workspace', identifier: 'WOR', name: 'Workspace' }
  const user: BoardActor = { kind: 'user', id: '__self__' }
  const agent: BoardActor = { kind: 'agent', id: 'agent-1' }
  /** Monday 2026-01-05 00:00 UTC. */
  const monday = 1_767_571_200
  let board: TestBoardStore

  beforeEach(async () => {
    board = await factory.open([{ id: workspace.id, identifier: 'WOR' }])
    await ensureDefaultColumns(board.store, workspace.id)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await board.dispose()
  })

  function at(second: number): void {
    vi.spyOn(Date, 'now').mockReturnValue(second * 1000)
  }

  const read = () => boardMetrics(board.store, { workspaceIds: [workspace.id], from: monday, to: monday + 86_399 }, monday + 86_000)

  it('puts a card created straight into a started column in WIP and aging, started at its creation', async () => {
    at(monday + 3_600)
    const created = await createCard(board.store, { workspace, title: 'agent in progress', statusName: 'In Progress' }, agent)

    const metrics = await read()

    expect(metrics.wip.find(wip => wip.slug === 'in_progress')!.cards).toBe(1)
    expect(metrics.aging.map(card => [card.issueId, card.startedAt, card.ageSeconds])).toEqual([[created.id, monday + 3_600, 86_000 - 3_600]])
  })

  it('reads a creation and moves that share a second in the order they were made', async () => {
    for (let index = 0; index < 25; index++) {
      at(monday + 3_600)
      const created = await createCard(board.store, { workspace, title: `Card ${index}`, statusName: 'To Do' }, agent)
      await moveCard(board.store, created.id, 'in_progress', agent)
      await moveCard(board.store, created.id, 'in_review', agent)
    }

    const metrics = await read()

    expect(metrics.wip.find(wip => wip.slug === 'in_review')!.cards).toBe(25)
    expect(metrics.cumulativeFlow.at(-1)!.cards.in_review).toBe(25)
    for (const card of metrics.aging) {
      expect(card).toMatchObject({ slug: 'in_review', startedAt: monday + 3_600, inColumnSeconds: 86_000 - 3_600 })
    }
  })

  it('leaves a card out of the cumulative flow while it sits in a column deleted since', async () => {
    at(monday + 3_600)
    const created = await createCard(board.store, { workspace, title: 'passing through', statusName: 'To Do' }, user)
    at(monday + 7_200)
    await moveCard(board.store, created.id, 'in_progress', agent)
    at(monday + 10_800)
    await moveCard(board.store, created.id, 'in_review', agent)
    at(monday + 14_400)
    await moveCard(board.store, created.id, 'done', user)
    at(monday + 18_000)
    await removeColumn(board.store, workspace.id, 'in_review', {}, user)

    const metrics = await read()

    expect(metrics.columns.map(column => column.slug)).not.toContain('in_review')
    expect(Object.fromEntries(metrics.timeInColumn.map(time => [time.slug, time.seconds]))).toMatchObject({ to_do: 3_600, in_progress: 3_600, done: 0 })
    expect(metrics.finished[0]).toMatchObject({ cycleSeconds: 7_200, leadSeconds: 10_800 })
    // Read at the end of the day the card is in Done; it was counted nowhere while it sat in the deleted column.
    expect(metrics.cumulativeFlow[0]!.cards.done).toBe(1)
  })
})

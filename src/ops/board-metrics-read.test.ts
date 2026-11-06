import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { TestBoardStore } from '../testing/board-stores'
import { BOARD_STORE_FACTORIES } from '../testing/board-stores'
import { METRICS_HISTORY, METRICS_INPUT, METRICS_NOW, METRICS_RETURN_COMMENT, METRICS_WORKSPACE, writeMetricsHistory } from '../testing/fixtures/board-metrics'
import { computeBoardMetrics } from './board-metrics'
import { boardMetrics, readBoardMetricsHistory } from './board-metrics-read'

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

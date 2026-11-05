import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { BoardStore } from '../board-store'
import { BoardError } from '../domain/errors'
import type { BoardWorkspaceIdentity } from '../domain/numbering'
import { createPostgresBoardStore } from '../postgres/board-store.postgres'
import { BOARD_AGENT_ROLE, BOARD_ROLE_SQL } from '../postgres/roles.sql'
import { createSqliteBoardStore } from '../sqlite/board-store.sqlite'
import type { TestBoardDatabase } from '../testing/board-database'
import { createTestBoardDatabase } from '../testing/board-database'
import { LOCK_HOLD_MS, LOCK_WAIT_MARGIN_MS, startLockHolder } from '../testing/lock-holder'
import type { TestPostgresDatabase } from '../testing/postgres-database'
import { createTestPostgresDatabase } from '../testing/postgres-database'
import { createCard } from './cards'
import { claimCard } from './claim'
import { ensureDefaultColumns, requireColumn, setColumnFlowRules } from './columns'
import { startRun } from './runs'
import type { BoardActor } from './types'

const WORKSPACE: BoardWorkspaceIdentity = { id: 'workspace', identifier: 'WOR', name: 'Workspace' }
const USER: BoardActor = { kind: 'user', id: '__self__' }
const AGENT: BoardActor = { kind: 'agent', id: 'agent-1' }

/** What another claimer writes when it takes the card: a run of its own. */
function otherClaimersRun(issueId: string): string {
  return `insert into issue_runs (id, issue_id, agent_name, state, started_at) values ('run-other', '${issueId}', 'other-claimer', 'running', unixepoch())`
}

/**
 * Two writers on one board file: this one, and another process holding the
 * file's write lock while it writes. Each write here has to wait for the lock
 * and then read what the other one committed.
 */
describe('two writers on one board file', () => {
  let board: TestBoardDatabase
  let store: BoardStore

  beforeEach(async () => {
    board = await createTestBoardDatabase()
    store = createSqliteBoardStore({ database: () => board.database })
    await ensureDefaultColumns(store, WORKSPACE.id)
  })

  afterEach(() => {
    board.dispose()
  })

  it('starts no second run on a card whose run another writer recorded while holding the file', async () => {
    const card = await createCard(store, { workspace: WORKSPACE, title: 'Card', statusName: 'To Do' }, USER)
    const holder = startLockHolder(board.path, [otherClaimersRun(card.id)])
    try {
      await holder.locked
      const startedAt = Date.now()

      const failure = await startRun(store, card.id, { agentName: 'claude' }, AGENT).then(() => undefined, (error: unknown) => error)

      const waited = Date.now() - startedAt
      await holder.assertHealthy()
      expect(waited).toBeGreaterThanOrEqual(LOCK_HOLD_MS - LOCK_WAIT_MARGIN_MS)
      expect(failure).toMatchObject({ code: 'board_card_run_active', details: { issueId: card.id, runId: 'run-other', agentName: 'other-claimer' } })
    }
    finally {
      await holder.stop()
    }
  })

  it('waits for another claimer holding the file, then takes the card that is still ready', async () => {
    const first = await createCard(store, { workspace: WORKSPACE, title: 'First', statusName: 'To Do' }, USER)
    const second = await createCard(store, { workspace: WORKSPACE, title: 'Second', statusName: 'To Do' }, USER)
    const inProgress = await requireColumn(store, WORKSPACE.id, 'In Progress')
    const holder = startLockHolder(board.path, [
      otherClaimersRun(first.id),
      `update issues set status_id = '${inProgress.id}' where id = '${first.id}'`,
    ])
    try {
      await holder.locked
      const startedAt = Date.now()

      const claimed = await claimCard(store, { workspaceId: WORKSPACE.id, run: { agentName: 'claude' } }, AGENT)

      const waited = Date.now() - startedAt
      await holder.assertHealthy()
      expect(waited).toBeGreaterThanOrEqual(LOCK_HOLD_MS - LOCK_WAIT_MARGIN_MS)
      expect(claimed.card.id).toBe(second.id)
      expect((await store.runs.listRunning(first.id)).map(run => run.id)).toEqual(['run-other'])
    }
    finally {
      await holder.stop()
    }
  })

  it('refuses a claim of the card another claimer took while holding the file', async () => {
    const card = await createCard(store, { workspace: WORKSPACE, title: 'Only one', statusName: 'To Do' }, USER)
    const holder = startLockHolder(board.path, [otherClaimersRun(card.id)])
    try {
      await holder.locked

      const failure = await claimCard(store, { workspaceId: WORKSPACE.id, issueId: card.id, run: { agentName: 'claude' } }, AGENT)
        .then(() => undefined, (error: unknown) => error)

      await holder.assertHealthy()
      expect(failure).toMatchObject({ code: 'board_card_not_ready', details: { issueId: card.id, reason: 'run_active' } })
      expect(await store.runs.countByIssue(card.id)).toBe(1)
    }
    finally {
      await holder.stop()
    }
  })
})

/**
 * Two claimers on one Postgres board. The embedded server runs one transaction
 * at a time, so the second claim's write waits for the first one to commit —
 * as a second connection waits on the card's row lock on a real server — and
 * then has to read what the first one did.
 */
describe('two claimers on one Postgres board', () => {
  let board: TestPostgresDatabase
  let store: BoardStore

  beforeEach(async () => {
    board = await createTestPostgresDatabase()
    store = createPostgresBoardStore({ database: board.database })
    await ensureDefaultColumns(store, WORKSPACE.id)
  })

  afterEach(async () => {
    await board.dispose()
  })

  async function claim(agentName: string) {
    return await claimCard(store, { workspaceId: WORKSPACE.id, run: { agentName } }, AGENT)
  }

  it('gives one ready card to one of two claimers racing for it; the other is told nothing is ready', async () => {
    const card = await createCard(store, { workspace: WORKSPACE, title: 'Only one', statusName: 'To Do' }, USER)

    const outcomes = await Promise.allSettled([claim('claude'), claim('codex')])

    const won = outcomes.filter(outcome => outcome.status === 'fulfilled')
    const lost = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
    expect(won).toHaveLength(1)
    expect(lost.map(outcome => (outcome.reason as BoardError).code)).toEqual(['board_nothing_ready'])
    expect(await store.runs.countByIssue(card.id)).toBe(1)
  })

  it('gives two claimers racing for two ready cards one card each', async () => {
    const first = await createCard(store, { workspace: WORKSPACE, title: 'First', statusName: 'To Do' }, USER)
    const second = await createCard(store, { workspace: WORKSPACE, title: 'Second', statusName: 'To Do' }, USER)

    const claimed = await Promise.all([claim('claude'), claim('codex')])

    expect(claimed.map(entry => entry.card.id).sort()).toEqual([first.id, second.id].sort())
  })

  it('claims as kanban_agent: the role holds every grant a claim needs, the row locks included', async () => {
    await board.client.exec(BOARD_ROLE_SQL)
    const inProgress = await requireColumn(store, WORKSPACE.id, 'In Progress')
    // A WIP limit makes the claim lock the column's row as well as the card's.
    await setColumnFlowRules(store, inProgress.id, { allowedFrom: null, wipLimit: 3 }, USER)
    const card = await createCard(store, { workspace: WORKSPACE, title: 'For the agent', statusName: 'To Do' }, USER)

    await board.client.exec(`set role "${BOARD_AGENT_ROLE}"`)
    try {
      expect((await claim('claude')).card).toMatchObject({ id: card.id, statusId: inProgress.id })
    }
    finally {
      await board.client.exec('reset role')
    }
  })
})

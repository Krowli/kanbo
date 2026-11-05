import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { BoardStore } from '../board-store'
import type { BoardWorkspaceIdentity } from '../domain/numbering'
import { createSqliteBoardStore } from '../sqlite/board-store.sqlite'
import type { TestBoardDatabase } from '../testing/board-database'
import { createTestBoardDatabase } from '../testing/board-database'
import { LOCK_HOLD_MS, LOCK_WAIT_MARGIN_MS, startLockHolder } from '../testing/lock-holder'
import { createCard } from './cards'
import { ensureDefaultColumns } from './columns'
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
})

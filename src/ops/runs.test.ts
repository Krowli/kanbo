import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { BoardStore } from '../board-store'
import type { BoardWorkspaceIdentity } from '../domain/numbering'
import type { TestBoardStore } from '../testing/board-stores'
import { BOARD_STORE_FACTORIES } from '../testing/board-stores'
import { createCard, setStatusLine } from './cards'
import {
  attachRunExecution,
  clearRunSessionRef,
  findRunByChatSessionId,
  finishRun,
  listRuns,
  readBoardProjection,
  readBoardProjectionForIssue,
  recordRunSessionRef,
  startRun,
} from './runs'
import type { BoardActor } from './types'

const WORKSPACE: BoardWorkspaceIdentity = { id: 'workspace', identifier: 'WOR', name: 'Workspace' }
const USER: BoardActor = { kind: 'user', id: '__self__' }
const AGENT: BoardActor = { kind: 'agent', id: 'agent-1' }
/** An agent no app launched: a `kanbo` shell, stored as the system with a name. */
const EXTERNAL: BoardActor = { kind: 'external', id: 'alice' }

describe.each(BOARD_STORE_FACTORIES)('board runs on $name', (factory) => {
  let board: TestBoardStore
  let store: BoardStore

  beforeEach(async () => {
    board = await factory.open([{ id: 'workspace', identifier: 'WOR' }])
    store = board.store
  })

  afterEach(async () => {
    await board.dispose()
  })

  async function createCardToRun(title = 'Card') {
    return await createCard(store, { workspace: WORKSPACE, title }, USER)
  }

  it('records the launch as a running row, a status line and a system comment', async () => {
    const card = await createCardToRun()

    const run = await startRun(store, card.id, { agentName: 'Claude', agentId: 'agent-1', host: 'laptop' }, USER)

    expect(run).toMatchObject({
      issueId: card.id,
      agentName: 'Claude',
      agentId: 'agent-1',
      host: 'laptop',
      state: 'running',
      executionMode: 'worktree',
      launchedByKind: 'user',
      endedAt: null,
    })
    expect((await store.issues.findById(card.id))?.statusLine).toBe('launched Claude')
    expect(await store.comments.listByIssue(card.id)).toEqual([
      expect.objectContaining({ authorKind: 'system.run', content: 'Run started: Claude · attempt 1 · worktree' }),
    ])
  })

  it('counts every launch as the next attempt and takes the card its execution mode', async () => {
    const card = await createCardToRun()
    await store.issues.update(card.id, { executionMode: 'main' })

    const first = await startRun(store, card.id, { agentName: 'Claude' }, USER)
    await finishRun(store, first.id, { state: 'finished' }, USER)
    const second = await startRun(store, card.id, { agentName: 'Codex' }, AGENT)

    expect(second.executionMode).toBe('main')
    expect(second.launchedByKind).toBe('agent')
    expect((await listRuns(store, card.id)).map(run => ({ attempt: run.attempt, agentName: run.agentName })))
      .toEqual([{ attempt: 1, agentName: 'Claude' }, { attempt: 2, agentName: 'Codex' }])
    expect((await readBoardProjectionForIssue(store, card.id)).attemptCount).toBe(2)
  })

  it('attaches the execution the run turned out to have, and refuses once it has ended', async () => {
    const card = await createCardToRun()
    const run = await startRun(store, card.id, { agentName: 'Claude' }, USER)

    const attached = await attachRunExecution(store, run.id, {
      chatSessionId: 'session-7',
      branch: 'kanbo/wor-001',
      worktreePath: '/tmp/worktrees/wor-001',
    })

    expect(attached).toMatchObject({ chatSessionId: 'session-7', branch: 'kanbo/wor-001', worktreePath: '/tmp/worktrees/wor-001' })
    expect(await findRunByChatSessionId(store, 'session-7')).toMatchObject({ id: run.id })
    expect(await findRunByChatSessionId(store, 'session-nobody')).toBeNull()

    await finishRun(store, run.id, { state: 'finished' }, USER)
    await expect(attachRunExecution(store, run.id, { branch: 'other' }))
      .rejects
.toMatchObject({ code: 'board_run_already_finished' })
  })

  it('takes the session an external agent names at launch, in the canonical claude:<id> / codex:<id> form', async () => {
    const card = await createCardToRun()

    const run = await startRun(store, card.id, {
      agentName: 'Claude',
      externalSessionRef: '  claude:abc-123  ',
    }, EXTERNAL)

    expect(run.externalSessionRef).toBe('claude:abc-123')
    expect((await listRuns(store, card.id))[0]?.externalSessionRef).toBe('claude:abc-123')
  })

  it('refuses a session ref it cannot parse back, and writes nothing', async () => {
    const card = await createCardToRun()

    await expect(startRun(store, card.id, { agentName: 'Claude', externalSessionRef: 'gpt:abc' }, EXTERNAL))
      .rejects
.toMatchObject({ code: 'board_run_session_ref_invalid' })
    expect(await store.runs.listByIssue(card.id)).toEqual([])
  })

  it('attaches a session ref after the run has started, once, and refuses an unparseable one', async () => {
    const card = await createCardToRun()
    const run = await startRun(store, card.id, { agentName: 'Claude' }, EXTERNAL)

    const attached = await attachRunExecution(store, run.id, { externalSessionRef: 'codex:session-9' })
    expect(attached.externalSessionRef).toBe('codex:session-9')

    await expect(attachRunExecution(store, run.id, { externalSessionRef: 'not-a-ref' }))
      .rejects
.toMatchObject({ code: 'board_run_session_ref_invalid' })
    expect((await store.runs.findById(run.id))?.externalSessionRef).toBe('codex:session-9')
  })

  it('never replaces or clears a session ref through attach, and keeps the same one on a repeat', async () => {
    const card = await createCardToRun()
    const run = await startRun(store, card.id, { agentName: 'Claude', externalSessionRef: 'claude:abc' }, EXTERNAL)

    expect((await attachRunExecution(store, run.id, { externalSessionRef: 'claude:abc', branch: 'b' })).branch).toBe('b')
    await expect(attachRunExecution(store, run.id, { externalSessionRef: 'claude:other' }))
      .rejects
      .toMatchObject({ code: 'board_run_session_ref_conflict' })
    await expect(attachRunExecution(store, run.id, { externalSessionRef: null }))
      .rejects
      .toMatchObject({ code: 'board_run_session_ref_conflict' })
    expect((await store.runs.findById(run.id))?.externalSessionRef).toBe('claude:abc')

    const bare = await startRun(store, card.id, { agentName: 'Claude' }, EXTERNAL)
    expect((await attachRunExecution(store, bare.id, { externalSessionRef: null })).externalSessionRef).toBeNull()
  })

  it('records a log picked after the run ended, keeps it on a repeat, and refuses a different one', async () => {
    const card = await createCardToRun()
    const run = await startRun(store, card.id, { agentName: 'Claude' }, EXTERNAL)
    await finishRun(store, run.id, { state: 'finished' }, EXTERNAL)

    expect((await recordRunSessionRef(store, run.id, ' claude:abc-123 ')).externalSessionRef).toBe('claude:abc-123')
    expect((await recordRunSessionRef(store, run.id, 'claude:abc-123')).externalSessionRef).toBe('claude:abc-123')
    await expect(recordRunSessionRef(store, run.id, 'codex:other'))
      .rejects
      .toMatchObject({ code: 'board_run_session_ref_conflict' })
    await expect(recordRunSessionRef(store, run.id, 'nope'))
      .rejects
      .toMatchObject({ code: 'board_run_session_ref_invalid' })
    await expect(recordRunSessionRef(store, 'no-such-run', 'claude:abc-123'))
      .rejects
      .toMatchObject({ code: 'board_run_not_found' })
    expect((await store.runs.findById(run.id))?.externalSessionRef).toBe('claude:abc-123')
  })

  it('lets a person clear or replace a run\'s log, after it ended, and refuses anyone else', async () => {
    const card = await createCardToRun()
    const run = await startRun(store, card.id, { agentName: 'Claude', externalSessionRef: 'codex:wrong' }, EXTERNAL)
    await finishRun(store, run.id, { state: 'finished' }, EXTERNAL)

    for (const actor of [AGENT, EXTERNAL]) {
      await expect(clearRunSessionRef(store, run.id, actor))
        .rejects
        .toMatchObject({ code: 'board_run_session_ref_requires_user' })
      await expect(clearRunSessionRef(store, run.id, actor, { replaceWith: 'claude:right' }))
        .rejects
        .toMatchObject({ code: 'board_run_session_ref_requires_user' })
    }
    await expect(clearRunSessionRef(store, run.id, { ...EXTERNAL, placesForPerson: true }))
      .rejects
      .toMatchObject({ code: 'board_run_session_ref_requires_user' })
    expect((await store.runs.findById(run.id))?.externalSessionRef).toBe('codex:wrong')

    await expect(clearRunSessionRef(store, run.id, USER, { replaceWith: 'nope' }))
      .rejects
      .toMatchObject({ code: 'board_run_session_ref_invalid' })
    expect((await clearRunSessionRef(store, run.id, USER, { replaceWith: ' claude:right ' })).externalSessionRef).toBe('claude:right')
    expect((await clearRunSessionRef(store, run.id, USER)).externalSessionRef).toBeNull()
    expect((await clearRunSessionRef(store, run.id, USER)).externalSessionRef).toBeNull()
    // Cleared, the run can be filled again the ordinary way.
    expect((await recordRunSessionRef(store, run.id, 'claude:again')).externalSessionRef).toBe('claude:again')
    await expect(clearRunSessionRef(store, 'no-such-run', USER))
      .rejects
      .toMatchObject({ code: 'board_run_not_found' })
  })

  it('says the agent left no report only when it wrote no status line after the launch', async () => {
    const withReport = await createCardToRun('Reported')
    const reportedRun = await startRun(store, withReport.id, { agentName: 'Claude' }, USER)
    await setStatusLine(store, withReport.id, 'ran out of budget, stopping here', AGENT)
    await finishRun(store, reportedRun.id, { state: 'failed', errorText: 'exit code 1' }, USER)

    const silent = await createCardToRun('Silent')
    const silentRun = await startRun(store, silent.id, { agentName: 'Claude' }, USER)
    await finishRun(store, silentRun.id, { state: 'failed', errorText: 'exit code 1' }, USER)

    expect((await store.issues.findById(withReport.id))?.statusLine).toBe('ran out of budget, stopping here')
    expect((await store.issues.findById(silent.id))?.statusLine).toBe('agent exited with an error, no report')
    expect((await store.comments.listByIssue(silent.id)).at(-1))
      .toMatchObject({ authorKind: 'system.run', content: 'Run failed: exit code 1' })
  })

  it('keeps the report of an agent working from outside, whose lines are filed under its own name', async () => {
    const card = await createCardToRun('Outside')
    const run = await startRun(store, card.id, { agentName: 'Claude', launchedByKind: 'external' }, EXTERNAL)
    await setStatusLine(store, card.id, 'tests written, migration failing on CI', EXTERNAL)

    await finishRun(store, run.id, { state: 'failed', errorText: 'exit code 1' }, EXTERNAL)

    expect((await store.issues.findById(card.id))?.statusLine).toBe('tests written, migration failing on CI')
  })

  it('names the person who stopped a run, in the status line and in the comment', async () => {
    const card = await createCardToRun()
    const run = await startRun(store, card.id, { agentName: 'Claude' }, USER)

    await finishRun(store, run.id, { state: 'stopped' }, USER)

    expect((await store.issues.findById(card.id))?.statusLine).toBe('stopped by you')
    expect((await store.comments.listByIssue(card.id)).at(-1))
      .toMatchObject({ authorKind: 'system.run', content: 'Run stopped by you' })
  })

  it('stops a run without blaming the person when the app that launched it stopped it itself', async () => {
    const card = await createCardToRun()
    const run = await startRun(store, card.id, { agentName: 'Claude' }, USER)

    await finishRun(store, run.id, { state: 'stopped' }, { kind: 'external', id: null })

    expect((await store.issues.findById(card.id))?.statusLine).toBe('launched Claude')
    expect((await store.comments.listByIssue(card.id)).at(-1))
      .toMatchObject({ authorKind: 'system.run', content: 'Run stopped' })
  })

  it('says what stopped a run when nobody pressed stop, on the card and in the comment', async () => {
    const card = await createCardToRun()
    const run = await startRun(store, card.id, { agentName: 'Claude' }, USER)

    await finishRun(store, run.id, {
      state: 'stopped',
      reason: 'the host app restarted before the run finished',
      statusLine: 'interrupted by a restart',
    }, { kind: 'external', id: null })

    expect((await store.issues.findById(card.id))?.statusLine).toBe('interrupted by a restart')
    expect((await store.comments.listByIssue(card.id)).at(-1))
      .toMatchObject({ authorKind: 'system.run', content: 'Run stopped: the host app restarted before the run finished' })
  })

  it('says the reason rather than "stopped by you" even when a person is the actor', async () => {
    const card = await createCardToRun()
    const run = await startRun(store, card.id, { agentName: 'Claude' }, USER)

    await finishRun(store, run.id, {
      state: 'stopped',
      reason: 'the host app restarted before the run finished',
      statusLine: 'interrupted by a restart',
    }, USER)

    expect((await store.issues.findById(card.id))?.statusLine).toBe('interrupted by a restart')
    expect((await store.comments.listByIssue(card.id)).at(-1))
      .toMatchObject({ authorKind: 'system.run', content: 'Run stopped: the host app restarted before the run finished' })
  })

  it('leaves a finished run exactly as it is when asked to finish it again', async () => {
    const card = await createCardToRun()
    const run = await startRun(store, card.id, { agentName: 'Claude' }, USER)
    const finished = await finishRun(store, run.id, { state: 'finished' }, USER)
    const commentsAfterFirst = await store.comments.listByIssue(card.id)

    const again = await finishRun(store, run.id, { state: 'stopped' }, USER)

    expect(again).toEqual(finished)
    expect(await store.comments.listByIssue(card.id)).toEqual(commentsAfterFirst)
    expect((await store.issues.findById(card.id))?.statusLine).toBe('launched Claude')
  })

  it('projects every card of a workspace with its attempt count and the run going on now', async () => {
    const running = await createCardToRun('Running')
    const settled = await createCardToRun('Settled')
    await createCardToRun('Never launched')

    const firstAttempt = await startRun(store, running.id, { agentName: 'Claude' }, USER)
    await finishRun(store, firstAttempt.id, { state: 'failed' }, USER)
    const liveRun = await startRun(store, running.id, { agentName: 'Codex', agentId: 'agent-2', branch: 'topic' }, USER)
    const settledRun = await startRun(store, settled.id, { agentName: 'Claude' }, USER)
    await finishRun(store, settledRun.id, { state: 'finished' }, USER)

    const projection = await readBoardProjection(store, 'workspace')

    expect(projection.find(card => card.issueId === running.id)).toEqual({
      issueId: running.id,
      attemptCount: 2,
      activeRun: {
        id: liveRun.id,
        agentId: 'agent-2',
        agentName: 'Codex',
        state: 'running',
        branch: 'topic',
        executionMode: 'worktree',
        chatSessionId: null,
        startedAt: liveRun.startedAt,
      },
    })
    expect(projection.find(card => card.issueId === settled.id)).toEqual({
      issueId: settled.id,
      attemptCount: 1,
      activeRun: null,
    })
    expect(await readBoardProjectionForIssue(store, 'WOR-003')).toEqual({
      issueId: 'WOR-003',
      attemptCount: 0,
      activeRun: null,
    })
  })
})

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { BoardStore } from '../board-store'
import type { ColumnSpec } from '../domain/column-templates'
import { BoardError } from '../domain/errors'
import type { BoardWorkspaceIdentity } from '../domain/numbering'
import type { TestBoardStore } from '../testing/board-stores'
import { BOARD_STORE_FACTORIES } from '../testing/board-stores'
import { createCard, waitApproval } from './cards'
import { readChangeSeq } from './change-seq'
import { claimCard } from './claim'
import { applyColumnTemplate, ensureDefaultColumns, requireColumn, setColumnFlowRules } from './columns'
import { startRun } from './runs'
import type { BoardActor } from './types'

const WORKSPACE: BoardWorkspaceIdentity = { id: 'workspace', identifier: 'WOR', name: 'Workspace' }
const OTHER: BoardWorkspaceIdentity = { id: 'other', identifier: 'OTH', name: 'Other' }
const USER: BoardActor = { kind: 'user', id: '__self__' }
const AGENT: BoardActor = { kind: 'agent', id: 'agent-1' }

async function refusal(action: () => Promise<unknown>): Promise<BoardError> {
  const failure = await action().then(() => undefined, (error: unknown) => error)
  expect(failure).toBeInstanceOf(BoardError)
  return failure as BoardError
}

/** A column a test's own board is made of. */
function spec(name: string, category: ColumnSpec['category']): ColumnSpec {
  return { name, description: null, color: null, category }
}

describe.each(BOARD_STORE_FACTORIES)('claiming a card on $name', (factory) => {
  let board: TestBoardStore
  let store: BoardStore

  beforeEach(async () => {
    board = await factory.open([{ id: WORKSPACE.id, identifier: 'WOR' }, { id: OTHER.id, identifier: 'OTH' }])
    store = board.store
    await ensureDefaultColumns(store, WORKSPACE.id)
  })

  afterEach(async () => {
    await board.dispose()
  })

  async function cardIn(title: string, columnName: string, workspace = WORKSPACE) {
    return await createCard(store, { workspace, title, statusName: columnName }, USER)
  }

  it('takes the first ready card in board order: one write starts its run and moves it into the first started column', async () => {
    const first = await cardIn('First', 'To Do')
    await cardIn('Second', 'To Do')
    const inProgress = await requireColumn(store, WORKSPACE.id, 'In Progress')
    const version = await readChangeSeq(store)

    const claimed = await claimCard(store, { workspaceId: WORKSPACE.id, run: { agentName: 'claude' } }, AGENT)

    expect(claimed.column.id).toBe(inProgress.id)
    expect(claimed.card).toMatchObject({ id: first.id, statusId: inProgress.id, statusLine: 'launched claude' })
    expect(claimed.run).toMatchObject({ issueId: first.id, agentName: 'claude', state: 'running', launchedByKind: 'agent' })
    expect(await readChangeSeq(store)).toBe(version + 1)
    expect((await store.fieldChanges.listByIssueField(first.id, 'statusId')).at(-1))
      .toMatchObject({ fromValue: first.statusId, toValue: inProgress.id, actorKind: 'agent', actorId: 'agent-1' })
  })

  it('passes over cards that are taken or waiting for a person, and says so when none is left', async () => {
    const taken = await cardIn('Taken', 'To Do')
    await startRun(store, taken.id, { agentName: 'codex' }, AGENT)
    const waiting = await cardIn('Waiting', 'To Do')
    await waitApproval(store, waiting.id, {}, AGENT)
    await cardIn('Not yet', 'Backlog')
    const version = await readChangeSeq(store)

    const failure = await refusal(async () => await claimCard(store, { workspaceId: WORKSPACE.id, run: { agentName: 'claude' } }, AGENT))

    expect(failure.code).toBe('board_nothing_ready')
    expect(failure.details).toEqual({ workspaceId: WORKSPACE.id })
    expect(await readChangeSeq(store)).toBe(version)
  })

  it('claims a named card only when it is ready, and says why not', async () => {
    const idea = await cardIn('Idea', 'Backlog')
    const waiting = await cardIn('Waiting', 'To Do')
    await waitApproval(store, waiting.id, {}, AGENT)
    const taken = await cardIn('Taken', 'To Do')
    await startRun(store, taken.id, { agentName: 'codex' }, AGENT)
    await ensureDefaultColumns(store, OTHER.id)
    const elsewhere = await cardIn('Elsewhere', 'To Do', OTHER)
    const claim = async (issueId: string) => await refusal(async () =>
      await claimCard(store, { workspaceId: WORKSPACE.id, issueId, run: { agentName: 'claude' } }, AGENT))

    expect((await claim(idea.id)).details).toEqual({ issueId: idea.id, reason: 'not_in_to_do' })
    expect((await claim(waiting.id)).details).toEqual({ issueId: waiting.id, reason: 'waiting_for_person' })
    expect((await claim(taken.id)).details).toEqual({ issueId: taken.id, reason: 'run_active' })
    expect((await claim(elsewhere.id)).code).toBe('issue_not_found')

    const ready = await cardIn('Ready', 'To Do')
    expect((await claimCard(store, { workspaceId: WORKSPACE.id, issueId: ready.id, run: { agentName: 'claude' } }, AGENT)).card.id).toBe(ready.id)
  })

  it('holds the claim to the target column\'s rules: an agent is refused and nothing is written; a person goes through, warned', async () => {
    const inProgress = await requireColumn(store, WORKSPACE.id, 'In Progress')
    await setColumnFlowRules(store, inProgress.id, { allowedFrom: null, wipLimit: 1 }, USER)
    await cardIn('Already in progress', 'In Progress')
    const ready = await cardIn('Ready', 'To Do')
    const version = await readChangeSeq(store)

    const failure = await refusal(async () => await claimCard(store, { workspaceId: WORKSPACE.id, run: { agentName: 'claude' } }, AGENT))
    expect(failure.code).toBe('board_column_rules_unmet')
    expect(failure.details).toMatchObject({ issueId: ready.id, column: 'In Progress', unmet: [{ rule: 'wip_limit', detail: 'In Progress holds 1 of 1' }] })
    expect(await readChangeSeq(store)).toBe(version)
    expect(await store.runs.countByIssue(ready.id)).toBe(0)

    const person = await claimCard(store, { workspaceId: WORKSPACE.id, run: { agentName: 'me' } }, USER)
    expect(person.card).toMatchObject({ id: ready.id, statusId: inProgress.id, unmetRules: [{ rule: 'wip_limit', reason: 'column_full' }] })
  })

  it('leaves the card and the board as they were when the run cannot start', async () => {
    const ready = await cardIn('Ready', 'To Do')
    const version = await readChangeSeq(store)

    const failure = await refusal(async () =>
      await claimCard(store, { workspaceId: WORKSPACE.id, run: { agentName: 'claude', externalSessionRef: 'not-a-ref' } }, AGENT))

    expect(failure.code).toBe('board_run_session_ref_invalid')
    expect(await readChangeSeq(store)).toBe(version)
    expect(await store.issues.findById(ready.id)).toMatchObject({ statusId: ready.statusId, statusLine: null })
    expect(await store.runs.countByIssue(ready.id)).toBe(0)
  })

  it('moves the card into the board\'s first started column, whatever it is called', async () => {
    const own = { id: 'own', identifier: 'OWN', name: 'Own columns' }
    await applyColumnTemplate(store, own.id, [spec('To Do', 'unstarted'), spec('Doing', 'started'), spec('Checking', 'started'), spec('Done', 'completed')], { mode: 'seed' })
    const card = await cardIn('Ready', 'To Do', own)

    const claimed = await claimCard(store, { workspaceId: own.id, run: { agentName: 'claude' } }, AGENT)

    expect(claimed.card.id).toBe(card.id)
    expect(claimed.column.name).toBe('Doing')
  })

  it('refuses a board with no started column to move the card to', async () => {
    const flat = { id: 'flat', identifier: 'FLA', name: 'Flat' }
    await applyColumnTemplate(store, flat.id, [spec('To Do', 'unstarted'), spec('Done', 'completed')], { mode: 'seed' })
    await cardIn('Ready', 'To Do', flat)

    const failure = await refusal(async () => await claimCard(store, { workspaceId: flat.id, run: { agentName: 'claude' } }, AGENT))

    expect(failure).toMatchObject({ code: 'issue_status_not_found', details: { workspaceId: 'flat', category: 'started' } })
  })
})

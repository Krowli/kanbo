import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { BoardStore } from '../board-store'
import { BoardError } from '../domain/errors'
import type { BoardWorkspaceIdentity } from '../domain/numbering'
import { createSqliteBoardStore } from '../sqlite/board-store.sqlite'
import { openBoardDatabase } from '../sqlite/open-database'
import { createTestBoardDatabase, seedWorkspace } from '../testing/board-database'
import type { TestBoardStore } from '../testing/board-stores'
import { BOARD_STORE_FACTORIES } from '../testing/board-stores'
import {
  addComment,
  approve,
  createCard,
  createCommentOnce,
  createSubCard,
  deleteCard,
  deleteComment,
  moveCard,
  assertReturnable,
  returnCard,
  searchCards,
  setStatusLine,
  updateCard,
  waitApproval,
} from './cards'
import { readChangeSeq, runBoardWrite } from './change-seq'
import { ensureDefaultColumns, listColumns } from './columns'
import { createRelation } from './relations'
import { startRun } from './runs'
import type { BoardActor } from './types'

const WORKSPACE: BoardWorkspaceIdentity = { id: 'workspace', identifier: 'WOR', name: 'Workspace' }
const USER: BoardActor = { kind: 'user', id: '__self__' }
const AGENT: BoardActor = { kind: 'agent', id: 'agent-1' }

describe.each(BOARD_STORE_FACTORIES)('board cards on $name', (factory) => {
  let board: TestBoardStore
  let store: BoardStore

  beforeEach(async () => {
    board = await factory.open([{ id: 'workspace', identifier: 'WOR' }])
    store = board.store
  })

  afterEach(async () => {
    await board.dispose()
  })

  it('numbers cards in sequence, including two written inside one transaction', async () => {
    const [first, second] = await runBoardWrite(store, async (scope) => {
      return [
        await createCard(store, { workspace: WORKSPACE, title: 'First' }, USER, scope),
        await createCard(store, { workspace: WORKSPACE, title: 'Second' }, USER, scope),
      ]
    })

    expect([first.id, second.id]).toEqual(['WOR-001', 'WOR-002'])
    expect([first.number, second.number]).toEqual([1, 2])
  })

  it('titles a card written without a title, or with a blank one, with its own key', async () => {
    const untitled = await createCard(store, { workspace: WORKSPACE, description: 'Fix the login redirect' }, USER)
    const blank = await createCard(store, { workspace: WORKSPACE, title: '  ', description: 'Another' }, USER)

    expect(untitled.title).toBe('WOR-001')
    expect(untitled.description).toBe('Fix the login redirect')
    expect(blank.title).toBe('WOR-002')
  })

  it('puts a sub-card under its parent, in the same workspace', async () => {
    const parent = await createCard(store, { workspace: WORKSPACE, title: 'Parent' }, USER)

    const child = await createSubCard(store, parent.id, { workspace: WORKSPACE, title: 'Child' }, USER)

    expect(child.parentIssueId).toBe(parent.id)
    expect(child.workspaceId).toBe(parent.workspaceId)
  })

  it('moves a card by column id, by slug and by name', async () => {
    const card = await createCard(store, { workspace: WORKSPACE, title: 'Card' }, USER)
    const columns = await listColumns(store, 'workspace')

    expect((await moveCard(store, card.id, 'in-progress', USER)).statusId)
      .toBe(columns.find(column => column.name === 'In Progress')?.id)
    expect((await moveCard(store, card.id, 'In Review', USER)).statusId)
      .toBe(columns.find(column => column.name === 'In Review')?.id)
    expect((await moveCard(store, card.id, columns[0].id, USER)).statusId).toBe(columns[0].id)
    await expect(moveCard(store, card.id, 'Nowhere', USER)).rejects.toMatchObject({ code: 'issue_status_not_found' })
  })

  it('reports an unknown column the way the caller named it', async () => {
    const card = await createCard(store, { workspace: WORKSPACE, title: 'Card' }, USER)

    const byId = await createCard(store, { workspace: WORKSPACE, title: 'Nope', statusId: 'missing-status' }, USER)
      .catch((error: unknown) => error)
    const byName = await updateCard(store, card.id, { statusName: 'Nowhere' }, USER)
      .catch((error: unknown) => error)

    expect(byId).toBeInstanceOf(BoardError)
    expect((byId as BoardError).code).toBe('issue_status_not_found')
    expect((byId as BoardError).details).toEqual({ workspaceId: 'workspace', statusId: 'missing-status' })
    expect(byName).toBeInstanceOf(BoardError)
    expect((byName as BoardError).details)
      .toEqual({ workspaceId: 'workspace', statusName: 'Nowhere', normalizedStatusName: 'nowhere' })
  })

  it('writes the status line as a column and as a field change carrying the actor', async () => {
    const card = await createCard(store, { workspace: WORKSPACE, title: 'Card' }, USER)

    const updated = await setStatusLine(store, card.id, 'reading the repository', AGENT)

    expect(updated.statusLine).toBe('reading the repository')
    expect(await store.fieldChanges.listByIssueField(card.id, 'statusLine')).toEqual([
      expect.objectContaining({ field: 'statusLine', fromValue: null, toValue: 'reading the repository', actorKind: 'agent', actorId: 'agent-1' }),
    ])
  })

  it('refuses an approval that does not come from a person', async () => {
    const card = await createCard(store, { workspace: WORKSPACE, title: 'Card' }, USER)
    await waitApproval(store, card.id, { statusLine: 'waiting for you' }, AGENT)

    await expect(approve(store, card.id, {}, AGENT)).rejects.toBeInstanceOf(BoardError)
    await expect(approve(store, card.id, {}, AGENT)).rejects.toMatchObject({ code: 'board_approval_requires_user' })
    expect((await store.issues.findById(card.id))?.waitingFor).toBe('human')
  })

  it('clears the wait and records the approval as a system comment', async () => {
    const card = await createCard(store, { workspace: WORKSPACE, title: 'Card' }, USER)
    await waitApproval(store, card.id, { statusLine: 'waiting for you' }, AGENT)

    const approved = await approve(store, card.id, { comment: 'ship it' }, USER)

    expect(approved.waitingFor).toBeNull()
    expect(await store.comments.listByIssue(card.id)).toEqual([
      expect.objectContaining({ authorKind: 'system.approved', content: 'Approved\nship it' }),
    ])
  })

  it('returns a card to the column before it and stops the run it was in', async () => {
    const card = await createCard(store, { workspace: WORKSPACE, title: 'Card', statusName: 'In Review' }, USER)
    const run = await startRun(store, card.id, { agentName: 'Claude' }, USER)
    const columns = await listColumns(store, 'workspace')

    const returned = await returnCard(store, card.id, { comment: 'tests are missing' }, USER)

    expect(returned.card.statusId).toBe(columns.find(column => column.name === 'In Progress')?.id)
    expect(returned.card.statusLine).toBe('returned by a person: tests are missing')
    expect(returned.card.waitingFor).toBeNull()
    expect(returned.stoppedRunIds).toEqual([run.id])
    expect((await store.runs.findById(run.id))?.state).toBe('stopped')
    // Everything here happens within the same second, so the comments are
    // checked as a set rather than in the order `created_at` would sort them.
    const comments = await store.comments.listByIssue(card.id)
    expect(comments).toHaveLength(3)
    expect(comments.map(comment => ({ authorKind: comment.authorKind, content: comment.content })))
      .toEqual(expect.arrayContaining([
        { authorKind: 'system.returned', content: 'tests are missing' },
        { authorKind: 'system.run', content: 'Run stopped' },
      ]))
  })

  it('refuses a return that does not come from a person, and leaves the card where it is', async () => {
    const card = await createCard(store, { workspace: WORKSPACE, title: 'Card', statusName: 'In Review' }, USER)
    const run = await startRun(store, card.id, { agentName: 'Claude' }, USER)
    await waitApproval(store, card.id, { statusLine: 'ready for your review' }, AGENT)

    await expect(returnCard(store, card.id, { comment: 'I will redo it' }, AGENT)).rejects.toBeInstanceOf(BoardError)
    await expect(returnCard(store, card.id, { comment: 'I will redo it' }, AGENT))
      .rejects
.toMatchObject({ code: 'board_return_requires_user' })

    const untouched = await store.issues.findById(card.id)
    expect(untouched?.waitingFor).toBe('human')
    expect(untouched?.statusLine).toBe('ready for your review')
    expect((await store.runs.findById(run.id))?.state).toBe('running')

    const returned = await returnCard(store, card.id, { comment: 'tests are missing' }, USER)
    expect(returned.card.statusLine).toBe('returned by a person: tests are missing')
  })

  it('refuses to return a card that is already in the first column', async () => {
    const card = await createCard(store, { workspace: WORKSPACE, title: 'Card', statusName: 'Backlog' }, USER)

    await expect(returnCard(store, card.id, { comment: 'nowhere to go' }, USER))
      .rejects
.toMatchObject({ code: 'board_return_no_previous_column' })
  })

  it('answers every refusal of a return on reads alone, and names where the card would go', async () => {
    const card = await createCard(store, { workspace: WORKSPACE, title: 'Card', statusName: 'In Review' }, USER)
    await waitApproval(store, card.id, { statusLine: 'ready for your review' }, AGENT)
    const columns = await listColumns(store, 'workspace')
    const before = await readChangeSeq(store)

    expect((await assertReturnable(store, card.id, {}, USER)).id).toBe(columns.find(column => column.name === 'In Progress')?.id)
    expect((await assertReturnable(store, card.id, { toStatusName: 'backlog' }, USER)).name).toBe('Backlog')
    await expect(assertReturnable(store, card.id, {}, AGENT)).rejects.toMatchObject({ code: 'board_return_requires_user' })
    await expect(assertReturnable(store, 'missing', {}, USER)).rejects.toMatchObject({ code: 'issue_not_found' })
    await expect(assertReturnable(store, card.id, { toStatusName: 'Nowhere' }, USER)).rejects.toMatchObject({ code: 'issue_status_not_found' })
    expect(await readChangeSeq(store)).toBe(before)
    expect((await store.issues.findById(card.id))?.waitingFor).toBe('human')

    const first = await createCard(store, { workspace: WORKSPACE, title: 'First', statusName: 'Backlog' }, USER)
    await expect(assertReturnable(store, first.id, {}, USER)).rejects.toMatchObject({ code: 'board_return_no_previous_column' })
  })

  it('locks the execution mode once the card has been launched', async () => {
    const card = await createCard(store, { workspace: WORKSPACE, title: 'Card' }, USER)

    expect((await updateCard(store, card.id, { executionMode: 'main' }, USER)).executionMode).toBe('main')
    expect(await store.fieldChanges.listByIssueField(card.id, 'executionMode')).toEqual([
      expect.objectContaining({ field: 'executionMode', fromValue: 'worktree', toValue: 'main', actorKind: 'user' }),
    ])

    await startRun(store, card.id, { agentName: 'Claude' }, USER)

    await expect(updateCard(store, card.id, { executionMode: 'worktree' }, USER))
      .rejects
.toMatchObject({ code: 'board_execution_mode_locked' })
    expect((await updateCard(store, card.id, { title: 'Renamed' }, USER)).title).toBe('Renamed')
  })

  it('puts a card under another and back on the top level, and records both in its history', async () => {
    const parent = await createCard(store, { workspace: WORKSPACE, title: 'Parent' }, USER)
    const card = await createCard(store, { workspace: WORKSPACE, title: 'Created at the wrong level' }, USER)

    expect((await updateCard(store, card.id, { parentIssueId: parent.id }, AGENT)).parentIssueId).toBe(parent.id)
    expect((await updateCard(store, card.id, { title: 'Renamed' }, AGENT)).parentIssueId).toBe(parent.id)
    expect((await updateCard(store, card.id, { parentIssueId: null }, USER)).parentIssueId).toBeNull()
    expect(await store.fieldChanges.listByIssueField(card.id, 'parentIssueId')).toEqual([
      expect.objectContaining({ field: 'parentIssueId', fromValue: null, toValue: parent.id, actorKind: 'agent' }),
      expect.objectContaining({ field: 'parentIssueId', fromValue: parent.id, toValue: null, actorKind: 'user' }),
    ])
  })

  it('refuses to put a card under itself, under one of its own sub-cards at any depth, or under a card of another workspace', async () => {
    const a = await createCard(store, { workspace: WORKSPACE, title: 'A' }, USER)
    const b = await createCard(store, { workspace: WORKSPACE, title: 'B' }, USER)
    await updateCard(store, a.id, { parentIssueId: b.id }, AGENT)
    const c = await createSubCard(store, a.id, { workspace: WORKSPACE, title: 'C' }, USER)
    const elsewhere = await createCard(store, { workspace: { id: 'other', identifier: 'OTH', name: 'Other' }, title: 'Elsewhere' }, USER)
    const before = await readChangeSeq(store)

    await expect(updateCard(store, b.id, { parentIssueId: b.id }, AGENT)).rejects.toMatchObject({ code: 'issue_parent_self_reference' })
    await expect(updateCard(store, b.id, { parentIssueId: a.id }, AGENT))
      .rejects
      .toMatchObject({ code: 'issue_parent_cycle', details: { issueId: b.id, parentIssueId: a.id } })
    await expect(updateCard(store, b.id, { parentIssueId: c.id }, AGENT))
      .rejects
      .toMatchObject({ code: 'issue_parent_cycle', details: { issueId: b.id, parentIssueId: c.id } })
    await expect(updateCard(store, b.id, { parentIssueId: elsewhere.id }, AGENT)).rejects.toMatchObject({ code: 'issue_parent_not_found' })

    expect((await store.issues.findById(b.id))?.parentIssueId).toBeNull()
    expect(await store.fieldChanges.listByIssueField(b.id, 'parentIssueId')).toEqual([])
    expect(await readChangeSeq(store)).toBe(before)
  })

  it('stops walking up a loop of parents the data already holds, rather than hanging on it', async () => {
    const first = await createCard(store, { workspace: WORKSPACE, title: 'First' }, USER)
    const second = await createSubCard(store, first.id, { workspace: WORKSPACE, title: 'Second' }, USER)
    // A loop no write of the board makes, put straight into the row.
    await store.issues.update(first.id, { parentIssueId: second.id })
    const card = await createCard(store, { workspace: WORKSPACE, title: 'Card' }, USER)

    expect((await updateCard(store, card.id, { parentIssueId: second.id }, USER)).parentIssueId).toBe(second.id)
    await expect(updateCard(store, first.id, { parentIssueId: card.id }, USER)).rejects.toMatchObject({ code: 'issue_parent_cycle' })
  })

  it('writes a deduplicated comment once, however often it is asked for', async () => {
    const card = await createCard(store, { workspace: WORKSPACE, title: 'Card' }, USER)

    const first = await createCommentOnce(store, {
      issueId: card.id,
      authorKind: 'system.pr',
      content: 'PR #7 opened: https://example.test/pull/7',
      dedupeKey: 'pr-opened:acme/repo#7',
      actor: USER,
    })
    const second = await createCommentOnce(store, {
      issueId: card.id,
      authorKind: 'system.pr',
      content: 'PR #7 opened again',
      dedupeKey: 'pr-opened:acme/repo#7',
      actor: USER,
    })

    expect(second.id).toBe(first.id)
    expect(second.content).toBe('PR #7 opened: https://example.test/pull/7')
    expect(await store.comments.listByIssue(card.id)).toHaveLength(1)
  })

  it('keeps a plain comment unconstrained by the dedupe index', async () => {
    const card = await createCard(store, { workspace: WORKSPACE, title: 'Card' }, USER)

    await addComment(store, { issueId: card.id, content: 'first' }, USER)
    await addComment(store, { issueId: card.id, content: 'second' }, USER)

    expect(await store.comments.listByIssue(card.id)).toHaveLength(2)
  })

  it('deletes a card, leaving its children without a parent and dropping its edges in both directions', async () => {
    const parent = await createCard(store, { workspace: WORKSPACE, title: 'Parent' }, USER)
    const child = await createSubCard(store, parent.id, { workspace: WORKSPACE, title: 'Child' }, USER)
    const other = await createCard(store, { workspace: WORKSPACE, title: 'Other' }, USER)
    await createRelation(store, { sourceIssueId: parent.id, targetIssueId: other.id, type: 'blocks' })
    await createRelation(store, { sourceIssueId: other.id, targetIssueId: parent.id, type: 'duplicates' })
    const run = await startRun(store, parent.id, { agentName: 'Claude' }, USER)

    expect(await deleteCard(store, parent.id)).toEqual({ runIds: [run.id] })

    expect(await store.issues.findById(parent.id)).toBeNull()
    expect((await store.issues.findById(child.id))?.parentIssueId).toBeNull()
    expect(await store.relations.listByIssue(other.id)).toEqual([])
    await expect(deleteCard(store, parent.id)).rejects.toMatchObject({ code: 'issue_not_found' })
  })

  it('lets only a person delete a comment the board wrote, and anyone delete a plain one', async () => {
    const card = await createCard(store, { workspace: WORKSPACE, title: 'Card' }, USER)
    await approve(store, card.id, {}, USER)
    const [decision] = await store.comments.listByIssue(card.id)
    const fact = await createCommentOnce(store, { issueId: card.id, authorKind: 'system', content: 'CI green', dedupeKey: 'ci:x', actor: USER })
    const plain = await addComment(store, { issueId: card.id, content: 'note' }, AGENT)

    await expect(deleteComment(store, decision.id, AGENT)).rejects.toMatchObject({
      code: 'issue_comment_delete_requires_user',
      details: { commentId: decision.id, actorKind: 'agent' },
    })
    await expect(deleteComment(store, fact.id, { kind: 'external', id: 'script' })).rejects.toMatchObject({
      code: 'issue_comment_delete_requires_user',
      details: { actorKind: 'system' },
    })
    await deleteComment(store, plain.id, AGENT)
    await deleteComment(store, decision.id, USER)

    expect((await store.comments.listByIssue(card.id)).map(comment => comment.id)).toEqual([fact.id])
    await expect(deleteComment(store, plain.id, USER)).rejects.toMatchObject({ code: 'issue_comment_not_found' })
  })

  it('finds cards by key, number, title or description, ignoring case, newest first and up to the limit', async () => {
    const byTitle = await createCard(store, { workspace: WORKSPACE, title: 'Fix the LOGIN redirect' }, USER)
    const byDescription = await createCard(store, { workspace: WORKSPACE, title: 'Other', description: 'login breaks on Safari' }, USER)
    await createCard(store, { workspace: WORKSPACE, title: 'Unrelated' }, USER)
    await store.issues.update(byTitle.id, { createdAt: 100 })
    await store.issues.update(byDescription.id, { createdAt: 200 })

    expect((await searchCards(store, 'Login', 10)).map(card => card.id)).toEqual([byDescription.id, byTitle.id])
    expect((await searchCards(store, 'login', 1)).map(card => card.id)).toEqual([byDescription.id])
    expect((await searchCards(store, 'wor-003', 10)).map(card => card.title)).toEqual(['Unrelated'])
  })

  it('seeds the standard columns the first time a card needs one', async () => {
    await createCard(store, { workspace: WORKSPACE, title: 'Card' }, USER)

    expect((await ensureDefaultColumns(store, 'workspace')).map(column => column.name))
      .toEqual(['Backlog', 'To Do', 'In Progress', 'In Review', 'Done', 'Canceled'])
  })
})

/**
 * The one card scenario that is about the file rather than about the board: two
 * connections onto it. A board in a database has no counterpart — everything
 * that reaches it is already a second connection — so this opens the file
 * itself instead of asking for whichever store the engine list offers.
 */
describe('board cards written through two connections onto one file', () => {
  it('gives a card written through a second connection onto the same file its own number', async () => {
    const board = await createTestBoardDatabase()
    seedWorkspace(board, 'workspace', 'WOR')
    const store = createSqliteBoardStore({ database: () => board.database })
    const second = await openBoardDatabase(board.path)
    const throughSecondConnection = createSqliteBoardStore({ database: () => second.database })

    try {
      const first = await createCard(store, { workspace: WORKSPACE, title: 'First' }, USER)
      const fromOtherConnection = await createCard(throughSecondConnection, { workspace: WORKSPACE, title: 'Second' }, USER)

      expect([first.id, fromOtherConnection.id]).toEqual(['WOR-001', 'WOR-002'])
      // Each connection sees what the other committed, so neither reuses a number.
      expect((await store.issues.listByWorkspace('workspace')).map(card => card.id)).toEqual(['WOR-001', 'WOR-002'])
      expect((await throughSecondConnection.issues.listByWorkspace('workspace')).map(card => card.id)).toEqual(['WOR-001', 'WOR-002'])
    }
    finally {
      second.close()
      board.dispose()
    }
  })
})

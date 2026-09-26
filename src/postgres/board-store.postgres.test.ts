import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import type { BoardStore } from '../board-store'
import type { BoardWorkspaceIdentity } from '../domain/numbering'
import { createCard } from '../ops/cards'
import type { BoardActor } from '../ops/types'
import type { TestPostgresDatabase } from '../testing/postgres-database'
import { createTestPostgresDatabase } from '../testing/postgres-database'
import { createPostgresBoardStore } from './board-store.postgres'

const WORKSPACE: BoardWorkspaceIdentity = { id: 'workspace', identifier: 'WOR', name: 'Workspace' }
const USER: BoardActor = { kind: 'user', id: '__self__' }

/**
 * What a board in Postgres does that a board in a file does not.
 *
 * The scenarios every store answers live in the contract; these are the places
 * where the dialect itself is the subject: numbering two writers at once, a
 * statement refused inside a transaction, the insertion order rows written in
 * the same second are read back in — and the column that carries it, which
 * must never leave the store — and what a nested transaction really is.
 *
 * One embedded Postgres serves the whole file, emptied between scenarios:
 * starting one costs far more than every scenario here put together.
 */
describe('the board store on Postgres', () => {
  let board: TestPostgresDatabase
  let store: BoardStore

  beforeEach(async () => {
    board ??= await createTestPostgresDatabase()
    await board.reset()
    store = createPostgresBoardStore({ database: board.database })
  })

  afterAll(async () => {
    await board?.dispose()
  })

  it('gives two writes of a card that overlap their own numbers', async () => {
    // Two callers, neither waiting for the other. The embedded Postgres these
    // tests run on holds one connection, so it runs the two transactions one
    // after the other rather than truly at once — what is being checked here is
    // that each write reads the board for itself, so neither can hand out a
    // number the other already used.
    const [first, second] = await Promise.all([
      createCard(store, { workspace: WORKSPACE, title: 'First' }, USER),
      createCard(store, { workspace: WORKSPACE, title: 'Second' }, USER),
    ])

    expect([first.number, second.number].sort()).toEqual([1, 2])
    expect((await store.issues.listByWorkspace(WORKSPACE.id)).map(card => card.id).sort())
      .toEqual(['WOR-001', 'WOR-002'])
  })

  it('leaves the transaction readable when the unique index refuses a card number', async () => {
    await store.issues.create({ id: 'WOR-001', workspaceId: WORKSPACE.id, number: 1, title: 'First' })

    const second = await store.transaction(async (tx) => {
      // A writer that read the board a moment too early picks a number that is
      // taken by now. This is the refusal card numbering is built on.
      await expect(tx.issues.create({ id: 'WOR-001-again', workspaceId: WORKSPACE.id, number: 1, title: 'Loser' }))
        .rejects
        .toThrow()

      // The refusal cost the statement and not the transaction — without the
      // savepoint around the insert, Postgres would refuse every read after it
      // — so the numbering can ask whose number that was and take the next one.
      expect(await tx.issues.findByNumber(WORKSPACE.id, 1)).toEqual(expect.objectContaining({ id: 'WOR-001' }))
      return await tx.issues.create({ id: 'WOR-002', workspaceId: WORKSPACE.id, number: 2, title: 'Second' })
    })

    expect(second.number).toBe(2)
    expect((await store.issues.listByWorkspace(WORKSPACE.id)).map(card => card.id)).toEqual(['WOR-001', 'WOR-002'])
  })

  it('reads runs started in the same second back in the order they were written', async () => {
    const card = await store.issues.create({ id: 'WOR-001', workspaceId: WORKSPACE.id, number: 1, title: 'Card' })
    // Three launches the clock cannot tell apart: only `seq` separates them.
    await store.runs.create({ id: 'run-1', issueId: card.id, agentName: 'Claude', startedAt: 1_000 })
    await store.runs.create({ id: 'run-2', issueId: card.id, agentName: 'Codex', startedAt: 1_000, chatSessionId: 'session-1' })
    await store.runs.create({ id: 'run-3', issueId: card.id, agentName: 'Claude', startedAt: 1_000, chatSessionId: 'session-1' })

    expect((await store.runs.listByIssue(card.id)).map(run => run.id)).toEqual(['run-1', 'run-2', 'run-3'])
    expect((await store.runs.findByChatSessionId('session-1'))?.id).toBe('run-3')
    // The projection ranks by the same three keys, so the newest launch is the
    // one the card shows as active.
    expect(await store.runs.project({ workspaceId: WORKSPACE.id })).toEqual([
      { issueId: card.id, attemptCount: 3, activeRun: expect.objectContaining({ id: 'run-3' }) },
    ])
  })

  it('hands back a run without the column it ordered them by', async () => {
    const card = await store.issues.create({ id: 'WOR-001', workspaceId: WORKSPACE.id, number: 1, title: 'Card' })

    // `seq` is a fact about this storage, not about the run. Every other
    // assertion compares one store result against another, so both sides would
    // carry it or neither would — and it would travel out through `IssueRun`
    // into `--json` and the server's run views on this engine alone.
    const created = await store.runs.create({ id: 'run-1', issueId: card.id, agentName: 'Claude' })
    expect(created).not.toHaveProperty('seq')
    expect((await store.runs.listByIssue(card.id))[0]).not.toHaveProperty('seq')
    expect(await store.runs.findById('run-1')).not.toHaveProperty('seq')
  })

  it('reads same-second history back in insertion order after the space of a deleted row is reused', async () => {
    const card = await store.issues.create({ id: 'WOR-001', workspaceId: WORKSPACE.id, number: 1, title: 'Card' })
    const other = await store.issues.create({ id: 'WOR-002', workspaceId: WORKSPACE.id, number: 2, title: 'Other' })

    await store.comments.create({ id: 'comment-1', issueId: card.id, content: 'First', createdAt: 1_000 })
    await store.comments.create({ id: 'comment-2', issueId: card.id, content: 'Second', createdAt: 1_000 })
    await store.fieldChanges.create({ id: 'change-1', issueId: card.id, field: 'statusLine', toValue: 'first', createdAt: 1_000 })
    await store.fieldChanges.create({ id: 'change-2', issueId: other.id, field: 'statusLine', toValue: 'elsewhere', createdAt: 1_000 })

    // A deleted row leaves a hole, and `vacuum` hands it to the next insert —
    // so the row written *last* lands physically in the middle. Ordering by
    // `created_at` alone therefore reads a board back in an order that is
    // neither insertion nor anything else a caller could name, which is what
    // `seq` is here to settle. (The card deleted below takes its own field
    // change with it by cascade, freeing a hole in that table too.)
    await store.comments.delete('comment-1')
    await store.issues.delete(other.id)
    await board.client.exec('vacuum "issue_comments", "issue_field_changes"')

    await store.comments.create({ id: 'comment-3', issueId: card.id, content: 'Third', createdAt: 1_000 })
    await store.fieldChanges.create({ id: 'change-3', issueId: card.id, field: 'statusLine', toValue: 'third', createdAt: 1_000 })

    expect((await store.comments.listByIssue(card.id)).map(comment => comment.id)).toEqual(['comment-2', 'comment-3'])
    expect((await store.fieldChanges.listByIssue(card.id)).map(change => change.id)).toEqual(['change-1', 'change-3'])
    expect((await store.fieldChanges.listByIssueField(card.id, 'statusLine')).map(change => change.id))
      .toEqual(['change-1', 'change-3'])
  })

  it('hands back a comment and a field change without the column it ordered them by', async () => {
    const card = await store.issues.create({ id: 'WOR-001', workspaceId: WORKSPACE.id, number: 1, title: 'Card' })

    // The same rule the runs follow: `seq` belongs to this storage, and a
    // comment that carried it would travel out through `IssueComment` into
    // `--json` and the server's card views on this engine alone.
    const created = await store.comments.create({ id: 'comment-1', issueId: card.id, content: 'First' })
    const kept = await store.comments.createOnce({ id: 'comment-2', issueId: card.id, content: 'Keyed', dedupeKey: 'run-1' })
    await store.fieldChanges.create({ id: 'change-1', issueId: card.id, field: 'statusLine', toValue: 'first' })

    expect(created).not.toHaveProperty('seq')
    expect(kept).not.toHaveProperty('seq')
    expect((await store.comments.listByIssue(card.id))[0]).not.toHaveProperty('seq')
    expect(await store.comments.findById('comment-1')).not.toHaveProperty('seq')
    expect((await store.fieldChanges.listByIssue(card.id))[0]).not.toHaveProperty('seq')
    expect((await store.fieldChanges.listByIssueField(card.id, 'statusLine'))[0]).not.toHaveProperty('seq')
  })

  it('rolls a nested write back to its savepoint and commits everything around it', async () => {
    await store.issues.create({ id: 'WOR-001', workspaceId: WORKSPACE.id, number: 1, title: 'Standing' })

    await store.transaction(async (tx) => {
      await tx.comments.create({ id: 'comment-outer', issueId: 'WOR-001', content: 'Outer' })

      await expect(tx.transaction(async (innerTx) => {
        await innerTx.comments.create({ id: 'comment-inner', issueId: 'WOR-001', content: 'Inner' })
        // A statement Postgres refuses, rather than an error thrown beside it:
        // the whole transaction would be unusable from here on if the nested
        // one were not a savepoint of its own.
        await innerTx.issues.create({ id: 'WOR-001-again', workspaceId: WORKSPACE.id, number: 1, title: 'Refused' })
      })).rejects.toThrow()

      await tx.comments.create({ id: 'comment-after', issueId: 'WOR-001', content: 'After' })
    })

    expect((await store.comments.listByIssue('WOR-001')).map(comment => comment.id).sort())
      .toEqual(['comment-after', 'comment-outer'])
  })

  it('writes nothing at all when the transaction throws', async () => {
    await expect(store.transaction(async (tx) => {
      await tx.issues.create({ id: 'WOR-001', workspaceId: WORKSPACE.id, number: 1, title: 'Gone' })
      await tx.meta.bumpRevision('board', 1_000)
      throw new Error('forced rollback')
    })).rejects.toThrow('forced rollback')

    expect(await store.issues.listAll()).toEqual([])
    // The counter the migration seeded is still where it was: a write that
    // rolled back is not a change the board announces.
    expect(await store.meta.read('board')).toEqual(expect.objectContaining({ revision: 0 }))
  })
})

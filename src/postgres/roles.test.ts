import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'

import { linkPullRequest, listPullRequests, unlinkPullRequest } from '../ops/pull-requests'
import type { TestPostgresDatabase } from '../testing/postgres-database'
import { createTestPostgresDatabase } from '../testing/postgres-database'
import { createPostgresBoardStore } from './board-store.postgres'
import {
  AGENT_APPROVAL_COMMENT_REFUSAL,
  AGENT_WAITING_REFUSAL,
  BOARD_AGENT_ROLE,
  BOARD_PERSON_ROLE,
  BOARD_REFUSAL_ERRCODE,
  BOARD_ROLE_SQL,
} from './roles.sql'
import { issueComments, issues } from './schema'

const WORKSPACE = 'ws-postgres-roles'
const CARD = 'issue-waiting'

/**
 * Run one statement as one of the board's roles.
 *
 * `set role` and `reset role` are their own round trips rather than three
 * statements in one: a multi-statement message is one implicit transaction, and
 * a refusal there would roll the whole thing back and hide what the board looks
 * like afterwards — which is half of what these tests are checking.
 */
async function runAs(
  board: TestPostgresDatabase,
  role: string,
  statement: string,
  params: unknown[],
): Promise<(Error & { code?: string }) | undefined> {
  await board.client.exec(`set role "${role}"`)
  try {
    await board.client.query(statement, params)
    return undefined
  }
  catch (error) {
    return error as Error & { code?: string }
  }
  finally {
    await board.client.exec('reset role')
  }
}

async function readWaitingFor(board: TestPostgresDatabase): Promise<string | null> {
  const [row] = await board.database.select({ waitingFor: issues.waitingFor }).from(issues).where(eq(issues.id, CARD))
  return row?.waitingFor ?? null
}

async function readCommentKinds(board: TestPostgresDatabase): Promise<string[]> {
  const rows = await board.database.select({ kind: issueComments.authorKind }).from(issueComments)
  return rows.map(row => row.kind)
}

/** The three things an update could change about a decision, read back as one. */
async function readComment(board: TestPostgresDatabase, id: string): Promise<{ content: string, kind: string, createdAt: number } | null> {
  const [row] = await board.database
    .select({ content: issueComments.content, kind: issueComments.authorKind, createdAt: issueComments.createdAt })
    .from(issueComments)
    .where(eq(issueComments.id, id))
  return row ?? null
}

describe('the board roles in Postgres', () => {
  let board: TestPostgresDatabase | undefined

  afterAll(async () => {
    await board?.dispose()
    board = undefined
  })

  /**
   * The board with its roles on it and one card waiting for a person.
   *
   * One embedded Postgres serves the whole file: the roles, the functions and
   * the triggers belong to the database and survive a `reset()`, which takes
   * only the rows — so each scenario still starts from the same board, without
   * paying for a second server.
   */
  async function boardWithRoles(): Promise<TestPostgresDatabase> {
    const created = board ??= await createTestPostgresDatabase()
    await created.reset()
    await created.client.exec(BOARD_ROLE_SQL)
    await created.database.insert(issues).values({
      id: CARD,
      workspaceId: WORKSPACE,
      number: 1,
      title: 'Waiting on a person',
      waitingFor: 'human',
    })
    return created
  }

  it('installs the same roles and triggers twice without complaint', async () => {
    board = await boardWithRoles()

    await expect(board.client.exec(BOARD_ROLE_SQL)).resolves.toBeDefined()
  })

  it('refuses the agent a card a person is holding', async () => {
    board = await boardWithRoles()

    const failure = await runAs(board, BOARD_AGENT_ROLE, 'update issues set waiting_for = null where id = $1', [CARD])

    expect(failure?.message).toBe(AGENT_WAITING_REFUSAL)
    // The code is half the refusal: the board's clients turn
    // `insufficient_privilege` into `board_approval_requires_user`, and a guard
    // that raised without it would read the same here and arrive as an
    // ordinary internal error there.
    expect(failure?.code).toBe(BOARD_REFUSAL_ERRCODE)
    expect(await readWaitingFor(board)).toBe('human')
  })

  it('lets the agent ask for a person, which is the direction the guard must not catch', async () => {
    board = await boardWithRoles()
    // Every `kanbo ready` an agent runs ends in this update; a guard written
    // one word wider would stop the whole agent flow on Postgres and nowhere else.
    await runAs(board, BOARD_PERSON_ROLE, 'update issues set waiting_for = null where id = $1', [CARD])

    const failure = await runAs(board, BOARD_AGENT_ROLE, `update issues set waiting_for = 'human' where id = $1`, [CARD])

    expect(failure).toBeUndefined()
    expect(await readWaitingFor(board)).toBe('human')
  })

  it('lets a person take the same card out of waiting', async () => {
    board = await boardWithRoles()

    const failure = await runAs(board, BOARD_PERSON_ROLE, 'update issues set waiting_for = null where id = $1', [CARD])

    expect(failure).toBeUndefined()
    expect(await readWaitingFor(board)).toBeNull()
  })

  it('refuses the agent a comment that speaks for a person', async () => {
    board = await boardWithRoles()

    const failure = await runAs(
      board,
      BOARD_AGENT_ROLE,
      `insert into issue_comments (id, issue_id, content, author_kind) values ($1, $2, $3, 'system.approved')`,
      ['comment-approved', CARD, 'Approved'],
    )

    expect(failure?.message).toBe(AGENT_APPROVAL_COMMENT_REFUSAL)
    expect(failure?.code).toBe(BOARD_REFUSAL_ERRCODE)
    expect(await readCommentKinds(board)).toEqual([])

    const returned = await runAs(
      board,
      BOARD_AGENT_ROLE,
      `insert into issue_comments (id, issue_id, content, author_kind) values ($1, $2, $3, 'system.returned')`,
      ['comment-returned', CARD, 'Returned'],
    )

    expect(returned?.message).toBe(AGENT_APPROVAL_COMMENT_REFUSAL)
    expect(await readCommentKinds(board)).toEqual([])
  })

  it('refuses the agent the deletion of a decision it could not have written', async () => {
    board = await boardWithRoles()
    await board.database.insert(issueComments).values([
      { id: 'comment-approved', issueId: CARD, content: 'Approved', authorKind: 'system.approved' },
      { id: 'comment-agent', issueId: CARD, content: 'Picked this up', authorKind: 'agent' },
    ])

    const decision = await runAs(board, BOARD_AGENT_ROLE, 'delete from issue_comments where id = $1', ['comment-approved'])
    const ownWord = await runAs(board, BOARD_AGENT_ROLE, 'delete from issue_comments where id = $1', ['comment-agent'])

    // A rule about who may write the decision is worth nothing if the other
    // side may erase it afterwards; everything the agent wrote is still its own.
    expect(decision?.message).toBe(AGENT_APPROVAL_COMMENT_REFUSAL)
    expect(decision?.code).toBe(BOARD_REFUSAL_ERRCODE)
    expect(ownWord).toBeUndefined()
    expect(await readCommentKinds(board)).toEqual(['system.approved'])
  })

  it('refuses the agent every rewrite of a decision a person made', async () => {
    board = await boardWithRoles()
    await board.database.insert(issueComments).values({
      id: 'comment-approved',
      issueId: CARD,
      content: 'Approved',
      authorKind: 'system.approved',
      createdAt: 1000,
    })

    // The three ways an update erases a decision without deleting the row:
    // take the kind off it, re-word the reason a person gave, and re-date it
    // past the moment a waiting session is looking back from.
    const kind = await runAs(board, BOARD_AGENT_ROLE, `update issue_comments set author_kind = 'agent' where id = $1`, ['comment-approved'])
    const content = await runAs(board, BOARD_AGENT_ROLE, 'update issue_comments set content = $1 where id = $2', ['Never mind', 'comment-approved'])
    const when = await runAs(board, BOARD_AGENT_ROLE, 'update issue_comments set created_at = $1 where id = $2', [9999, 'comment-approved'])

    expect([kind?.message, content?.message, when?.message])
      .toEqual([AGENT_APPROVAL_COMMENT_REFUSAL, AGENT_APPROVAL_COMMENT_REFUSAL, AGENT_APPROVAL_COMMENT_REFUSAL])
    expect([kind?.code, content?.code, when?.code])
      .toEqual([BOARD_REFUSAL_ERRCODE, BOARD_REFUSAL_ERRCODE, BOARD_REFUSAL_ERRCODE])
    expect(await readComment(board, 'comment-approved'))
      .toEqual({ content: 'Approved', kind: 'system.approved', createdAt: 1000 })
  })

  it('refuses the agent a comment of its own turned into a decision', async () => {
    board = await boardWithRoles()
    await board.database.insert(issueComments).values({
      id: 'comment-agent',
      issueId: CARD,
      content: 'Picked this up',
      authorKind: 'agent',
    })

    // The guard reads the row it is being made into as well as the one it is:
    // forging a decision by updating is the same act as forging one by
    // inserting, which the insert guard already refuses.
    const forged = await runAs(
      board,
      BOARD_AGENT_ROLE,
      `update issue_comments set author_kind = 'system.approved' where id = $1`,
      ['comment-agent'],
    )

    expect(forged?.message).toBe(AGENT_APPROVAL_COMMENT_REFUSAL)
    expect(forged?.code).toBe(BOARD_REFUSAL_ERRCODE)
    expect(await readCommentKinds(board)).toEqual(['agent'])
  })

  it('lets a person correct the decision they wrote', async () => {
    board = await boardWithRoles()
    await board.database.insert(issueComments).values({
      id: 'comment-returned',
      issueId: CARD,
      content: 'Send it back',
      authorKind: 'system.returned',
    })

    const failure = await runAs(board, BOARD_PERSON_ROLE, 'update issue_comments set content = $1 where id = $2', [
      'Send it back, the tests are red',
      'comment-returned',
    ])

    expect(failure).toBeUndefined()
    expect((await readComment(board, 'comment-returned'))?.content).toBe('Send it back, the tests are red')
  })

  it('refuses the agent the card itself, so a decision cannot be deleted along with it', async () => {
    board = await boardWithRoles()
    await board.database.insert(issueComments).values({
      id: 'comment-approved',
      issueId: CARD,
      content: 'Approved',
      authorKind: 'system.approved',
    })

    // Not a trigger: a cascading delete is carried out as the owner of the
    // table it reaches, so the comment guard sees the owner rather than the
    // agent and would let the decision go with the card. The grant is the only
    // place this can be said.
    const failure = await runAs(board, BOARD_AGENT_ROLE, 'delete from issues where id = $1', [CARD])

    expect(failure?.code).toBe(BOARD_REFUSAL_ERRCODE)
    expect(await readWaitingFor(board)).toBe('human')
    expect(await readCommentKinds(board)).toEqual(['system.approved'])
  })

  it('lets a person delete the same card, and its history goes with it', async () => {
    board = await boardWithRoles()
    await board.database.insert(issueComments).values({
      id: 'comment-approved',
      issueId: CARD,
      content: 'Approved',
      authorKind: 'system.approved',
    })

    const failure = await runAs(board, BOARD_PERSON_ROLE, 'delete from issues where id = $1', [CARD])

    expect(failure).toBeUndefined()
    expect(await readWaitingFor(board)).toBeNull()
    expect(await readCommentKinds(board)).toEqual([])
  })

  it('lets a person take the decision back out of the history', async () => {
    board = await boardWithRoles()
    await board.database.insert(issueComments).values({
      id: 'comment-approved',
      issueId: CARD,
      content: 'Approved',
      authorKind: 'system.approved',
    })

    const failure = await runAs(board, BOARD_PERSON_ROLE, 'delete from issue_comments where id = $1', ['comment-approved'])

    expect(failure).toBeUndefined()
    expect(await readCommentKinds(board)).toEqual([])
  })

  it('lets a person write the decision the agent could not', async () => {
    board = await boardWithRoles()

    const failure = await runAs(
      board,
      BOARD_PERSON_ROLE,
      `insert into issue_comments (id, issue_id, content, author_kind) values ($1, $2, $3, 'system.approved')`,
      ['comment-approved', CARD, 'Approved'],
    )

    expect(failure).toBeUndefined()
    expect(await readCommentKinds(board)).toEqual(['system.approved'])
  })

  it('leaves the agent everything else about the board', async () => {
    board = await boardWithRoles()

    const comment = await runAs(
      board,
      BOARD_AGENT_ROLE,
      `insert into issue_comments (id, issue_id, content, author_kind) values ($1, $2, $3, 'agent')`,
      ['comment-agent', CARD, 'Picked this up'],
    )
    const run = await runAs(
      board,
      BOARD_AGENT_ROLE,
      `insert into issue_runs (id, issue_id, agent_name) values ($1, $2, $3)`,
      ['run-1', CARD, 'claude'],
    )
    // Every `kanbo card status-line`, `card move` and `card update` an agent
    // runs writes one of these, and the row draws from a sequence of its own:
    // a grant that named the wrong one would refuse the whole agent flow on
    // this engine and nowhere else.
    const change = await runAs(
      board,
      BOARD_AGENT_ROLE,
      `insert into issue_field_changes (id, issue_id, field, to_value, actor_kind) values ($1, $2, 'statusLine', $3, 'agent')`,
      ['change-1', CARD, 'picking this up'],
    )
    const title = await runAs(board, BOARD_AGENT_ROLE, 'update issues set title = $1 where id = $2', ['Renamed', CARD])
    // Its own word stays its own to correct: the update guard reads the kind
    // of the row, not the role of whoever is writing.
    const ownWord = await runAs(board, BOARD_AGENT_ROLE, 'update issue_comments set content = $1 where id = $2', ['Still on it', 'comment-agent'])

    expect([comment, run, change, title, ownWord]).toEqual([undefined, undefined, undefined, undefined, undefined])
    expect(await readCommentKinds(board)).toEqual(['agent'])
    expect((await readComment(board, 'comment-agent'))?.content).toBe('Still on it')
  })

  it('lets the agent link and unlink a pull request on a card (ruling 4-4)', async () => {
    board = await boardWithRoles()
    const store = createPostgresBoardStore({ database: board.database })
    const agent = { kind: 'agent' as const, id: 'agent-1' }

    // Through the board's own operations, so the whole write is the agent's:
    // the link, the sequence its `seq` draws from, and the board version bump.
    await board.client.exec(`set role "${BOARD_AGENT_ROLE}"`)
    try {
      const link = await linkPullRequest(store, CARD, 'https://github.com/octo/repo/pull/7', agent)
      expect(await listPullRequests(store, CARD)).toEqual([link])
      expect(await unlinkPullRequest(store, CARD, link.id, agent)).toEqual(link)
      expect(await listPullRequests(store, CARD)).toEqual([])
    }
    finally {
      await board.client.exec('reset role')
    }
  })
})

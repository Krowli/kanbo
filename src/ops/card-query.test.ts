import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { BoardStore } from '../board-store'
import type { BoardWorkspaceIdentity } from '../domain/numbering'
import type { TestBoardStore } from '../testing/board-stores'
import { BOARD_STORE_FACTORIES } from '../testing/board-stores'
import { queryCards } from './card-query'
import { readCardAttention } from './approval'
import { addComment, approve, createCard, returnCard, updateCard, waitApproval } from './cards'
import { queryReady } from './ready'
import { finishRun, startRun } from './runs'
import { createMilestone, listSprints } from './sprints'
import type { BoardActor } from './types'

const WORKSPACE: BoardWorkspaceIdentity = { id: 'workspace', identifier: 'WOR', name: 'Workspace' }
const OTHER: BoardWorkspaceIdentity = { id: 'other', identifier: 'OTH', name: 'Other' }
const USER: BoardActor = { kind: 'user', id: '__self__' }

describe.each(BOARD_STORE_FACTORIES)('cards picked by a query on $name', (factory) => {
  let board: TestBoardStore
  let store: BoardStore

  beforeEach(async () => {
    board = await factory.open([{ id: WORKSPACE.id, identifier: WORKSPACE.identifier }, { id: OTHER.id, identifier: OTHER.identifier }])
    store = board.store
  })

  afterEach(async () => {
    await board.dispose()
  })

  async function card(title: string, statusName: string, extra: { description?: string, parent?: string } = {}) {
    return await createCard(store, {
      workspace: WORKSPACE,
      title,
      statusName,
      description: extra.description,
      parentIssueId: extra.parent,
    }, USER)
  }

  async function ids(input: Omit<Parameters<typeof queryCards>[1], 'workspaceId'>): Promise<string[]> {
    return (await queryCards(store, { workspaceId: WORKSPACE.id, ...input })).cards.map(row => row.title)
  }

  it('narrows by every filter, together, in board order, never outside the workspace', async () => {
    const parent = await card('Parent', 'To Do')
    const waiting = await card('Waiting in review', 'In Review')
    await waitApproval(store, waiting.id, {}, USER)
    const running = await card('Running', 'In Progress', { parent: parent.id })
    await startRun(store, running.id, { agentName: 'Claude' }, USER)
    await card('Idle child', 'In Progress', { parent: parent.id, description: 'Mentions the Parser here' })
    const labelled = await card('Labelled', 'Backlog')
    await updateCard(store, labelled.id, { labels: ['ui', 'bug'], priority: 'high' }, USER)
    await createCard(store, { workspace: OTHER, title: 'Elsewhere', statusName: 'To Do' }, USER)

    expect(await ids({})).toEqual(['Parent', 'Waiting in review', 'Running', 'Idle child', 'Labelled'])
    expect(await ids({ columns: ['in_progress', 'In Review'] })).toEqual(['Waiting in review', 'Running', 'Idle child'])
    expect(await ids({ waitingForPerson: true })).toEqual(['Waiting in review'])
    expect(await ids({ waitingForPerson: false, columns: ['in_review'] })).toEqual([])
    expect(await ids({ parentIssueId: parent.id })).toEqual(['Running', 'Idle child'])
    expect(await ids({ hasActiveRun: true })).toEqual(['Running'])
    expect(await ids({ hasActiveRun: false, parentIssueId: parent.id })).toEqual(['Idle child'])
    expect(await ids({ text: 'PARSER' })).toEqual(['Idle child'])
    expect(await ids({ text: waiting.id })).toEqual(['Waiting in review'])
    expect(await ids({ labels: ['bug'] })).toEqual(['Labelled'])
    expect(await ids({ labels: ['bug', 'ui'] })).toEqual(['Labelled'])
    expect(await ids({ labels: ['bu'] })).toEqual([])
    expect(await ids({ labels: ['bug', 'docs'] })).toEqual([])
    expect(await ids({ priorities: ['high', 'urgent'] })).toEqual(['Labelled'])
    expect(await ids({ priorities: [] })).toEqual([])
    expect(await ids({ columns: [] })).toEqual([])
  })

  it('picks the cards a person sent back that nobody picked up again, and says what the waiting and returned ones last said', async () => {
    const sentBack = await card('Sent back', 'In Review')
    await returnCard(store, sentBack.id, { comment: 'Tests are missing' }, USER)
    await addComment(store, { issueId: sentBack.id, content: 'On it' }, { kind: 'agent', id: 'claude' })
    const approvedLater = await card('Approved later', 'In Review')
    await returnCard(store, approvedLater.id, { comment: 'Not yet' }, USER)
    await approve(store, approvedLater.id, { comment: null }, USER)
    const handedBack = await card('Handed back', 'In Review')
    await returnCard(store, handedBack.id, { comment: 'Again' }, USER)
    await waitApproval(store, handedBack.id, {}, USER)
    const running = await card('Running again', 'In Review')
    await returnCard(store, running.id, { comment: 'Redo' }, USER)
    const run = await startRun(store, running.id, { agentName: 'Claude' }, USER)
    await card('Never returned', 'To Do')

    expect(await ids({ returned: true })).toEqual(['Sent back'])
    expect(await ids({ returned: false })).toEqual(['Approved later', 'Handed back', 'Running again', 'Never returned'])
    await finishRun(store, run.id, { state: 'finished' }, USER)
    expect(await ids({ returned: true })).toEqual(['Sent back', 'Running again'])

    const page = await queryCards(store, { workspaceId: WORKSPACE.id })
    const attention = await readCardAttention(store, page.cards, page.cards.map(() => false))
    expect(Object.fromEntries(page.cards.map((row, index) => [row.title, attention[index]]))).toEqual({
      'Sent back': { returned: true, lastComment: { author: 'agent', text: 'On it', createdAt: expect.any(Number) } },
      'Approved later': { returned: false, lastComment: null },
      'Handed back': { returned: false, lastComment: { author: 'user', text: 'Again', createdAt: expect.any(Number) } },
      // The run's own bookkeeping ("Run finished") is not what it last said.
      'Running again': { returned: true, lastComment: { author: 'user', text: 'Redo', createdAt: expect.any(Number) } },
      'Never returned': { returned: false, lastComment: null },
    })
    const long = await card('Long', 'In Review')
    await addComment(store, { issueId: long.id, content: 'x'.repeat(500) }, USER)
    await waitApproval(store, long.id, {}, USER)
    const [said] = await readCardAttention(store, [(await store.issues.findById(long.id))!], [false])
    expect(said!.lastComment!.text).toHaveLength(200)
    expect(said!.lastComment!.text.endsWith('…')).toBe(true)
  })

  it('reads the latest comment of each card, of the kinds asked, in one statement', async () => {
    const first = await card('First', 'To Do')
    const second = await card('Second', 'To Do')
    for (const content of ['one', 'two', 'three']) {
      await addComment(store, { issueId: first.id, content }, USER)
    }
    await addComment(store, { issueId: second.id, content: 'agent said' }, { kind: 'agent', id: 'claude' })

    const latest = await store.comments.listLatestByIssues([first.id, second.id])
    expect(Object.fromEntries(latest.map(comment => [comment.issueId, comment.content]))).toEqual({ [first.id]: 'three', [second.id]: 'agent said' })
    expect((await store.comments.listLatestByIssues([first.id, second.id], ['agent'])).map(comment => comment.content)).toEqual(['agent said'])
    expect(await store.comments.listLatestByIssues([])).toEqual([])
    expect(await store.comments.listLatestByIssues([first.id], [])).toEqual([])
  })

  it('matches text as written: % and _ are no wildcards', async () => {
    await card('Discount 50% off', 'To Do')
    await card('Discount 50 off', 'To Do')
    await card('snake_case name', 'To Do')
    await card('snakeXcase name', 'To Do')

    expect(await ids({ text: '50%' })).toEqual(['Discount 50% off'])
    expect(await ids({ text: 'snake_case' })).toEqual(['snake_case name'])
  })

  it('picks the cards changed at or after a moment', async () => {
    const old = await card('Old', 'To Do')
    const fresh = await card('Fresh', 'To Do')
    await store.issues.update(old.id, { updatedAt: 1_000 })
    await store.issues.update(fresh.id, { updatedAt: 2_000 })

    expect(await ids({ updatedSince: 2_000 })).toEqual(['Fresh'])
    expect(await ids({ updatedSince: 1_000 })).toEqual(['Old', 'Fresh'])
  })

  it('cuts a page and counts every picked card, a page past the end included', async () => {
    for (const title of ['One', 'Two', 'Three', 'Four', 'Five']) {
      await card(title, 'To Do')
    }

    const page = await queryCards(store, { workspaceId: WORKSPACE.id, offset: 1, limit: 2 })
    expect(page.cards.map(row => row.title)).toEqual(['Two', 'Three'])
    expect(page.total).toBe(5)
    expect(page.columns.map(column => column.name)).toContain('To Do')

    expect(await queryCards(store, { workspaceId: WORKSPACE.id, offset: 9 })).toMatchObject({ cards: [], total: 5 })
    expect(await queryCards(store, { workspaceId: WORKSPACE.id, text: 'nothing like it' })).toMatchObject({ cards: [], total: 0 })
  })

  it('refuses a column the board does not have', async () => {
    await card('Somewhere', 'To Do')

    await expect(queryCards(store, { workspaceId: WORKSPACE.id, columns: ['nowhere'] }))
      .rejects
      .toMatchObject({ code: 'issue_status_not_found' })
  })

  it('pages the ready cards and counts all of them', async () => {
    for (const title of ['First', 'Second', 'Third']) {
      await card(title, 'To Do')
    }
    const taken = await card('Taken', 'To Do')
    await startRun(store, taken.id, { agentName: 'Claude' }, USER)

    const page = await queryReady(store, { workspaceId: WORKSPACE.id, limit: 2 })
    expect(page.cards.map(row => row.title)).toEqual(['First', 'Second'])
    expect(page.total).toBe(3)
    expect((await queryReady(store, { workspaceId: WORKSPACE.id, offset: 2 })).cards.map(row => row.title)).toEqual(['Third'])
  })

  it('counts a sprint\'s open and done cards without reading the cards', async () => {
    const sprint = await createMilestone(store, { workspaceId: WORKSPACE.id, title: 'Sprint' })
    for (const [title, column] of [['A', 'To Do'], ['B', 'Done'], ['C', 'Canceled'], ['D', 'In Progress']] as const) {
      const created = await card(title, column)
      await updateCard(store, created.id, { milestoneId: sprint.id }, USER)
    }
    await card('Not in the sprint', 'Done')

    expect((await listSprints(store, WORKSPACE.id))[0]?.cards).toEqual({ open: 2, done: 2 })
    expect(await store.issues.countByMilestone(OTHER.id)).toEqual([])
  })
})

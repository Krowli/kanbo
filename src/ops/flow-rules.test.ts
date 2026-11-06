import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { BoardStore } from '../board-store'
import { COLUMN_TEMPLATES } from '../domain/column-templates'
import { BoardError } from '../domain/errors'
import { readFlowRules } from '../domain/flow-rules'
import type { BoardWorkspaceIdentity } from '../domain/numbering'
import type { TestBoardStore } from '../testing/board-stores'
import { BOARD_STORE_FACTORIES } from '../testing/board-stores'
import { readChangeSeq } from './change-seq'
import {
  addColumn,
  applyColumnTemplate,
  applyStandardFlow,
  deleteColumn,
  ensureDefaultColumns,
  listColumns,
  removeColumn,
  requireColumn,
  setColumnFlowRules,
} from './columns'
import type { BoardActor } from './types'

const WORKSPACE: BoardWorkspaceIdentity = { id: 'workspace', identifier: 'WOR', name: 'Workspace' }
const OTHER: BoardWorkspaceIdentity = { id: 'other', identifier: 'OTH', name: 'Other' }
const USER: BoardActor = { kind: 'user', id: '__self__' }
const AGENT: BoardActor = { kind: 'agent', id: 'agent-1' }
const EXTERNAL: BoardActor = { kind: 'external', id: 'alice' }

/** Run `action` and hand back the board error it threw. */
async function refusal(action: () => Promise<unknown>): Promise<BoardError> {
  const failure = await action().then(() => undefined, (error: unknown) => error)
  expect(failure).toBeInstanceOf(BoardError)
  return failure as BoardError
}

describe.each(BOARD_STORE_FACTORIES)('column flow rules on $name', (factory) => {
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

  async function column(name: string, workspaceId = WORKSPACE.id) {
    return await requireColumn(store, workspaceId, name)
  }

  it('gives a new board the standard flow: Done accepts cards from In Review only, every other column from anywhere', async () => {
    const inReview = await column('In Review')
    for (const each of await listColumns(store, WORKSPACE.id)) {
      expect(readFlowRules(each), each.name).toEqual(each.name === 'Done'
        ? { allowedFrom: [inReview.id], wipLimit: null }
        : { allowedFrom: null, wipLimit: null })
    }
  })

  it('gives a Review + QA board a Done that accepts cards from In Review and QA, and a Simple board no flow at all', async () => {
    await applyColumnTemplate(store, 'qa-board', COLUMN_TEMPLATES['review-qa'], { mode: 'seed' })
    expect(readFlowRules(await column('Done', 'qa-board')).allowedFrom).toEqual([(await column('In Review', 'qa-board')).id, (await column('QA', 'qa-board')).id])

    await applyColumnTemplate(store, 'simple-board', COLUMN_TEMPLATES.simple, { mode: 'seed' })
    for (const each of await listColumns(store, 'simple-board')) {
      expect(readFlowRules(each)).toEqual({ allowedFrom: null, wipLimit: null })
    }
  })

  it('sets, changes and clears a column\'s flow rules, keeping the allowed columns once each in board order', async () => {
    const [toDo, inProgress, inReview] = [await column('To Do'), await column('In Progress'), await column('In Review')]

    const set = await setColumnFlowRules(store, inReview.id, { allowedFrom: [inProgress.id, toDo.id, inProgress.id], wipLimit: 2 }, USER)
    expect(readFlowRules(set)).toEqual({ allowedFrom: [toDo.id, inProgress.id], wipLimit: 2 })

    expect(readFlowRules(await setColumnFlowRules(store, inReview.id, { allowedFrom: [], wipLimit: null }, USER))).toEqual({ allowedFrom: [], wipLimit: null })
    expect(readFlowRules(await setColumnFlowRules(store, inReview.id, { allowedFrom: null, wipLimit: null }, USER))).toEqual({ allowedFrom: null, wipLimit: null })
  })

  it.each([AGENT, EXTERNAL])('lets only a person set a column\'s flow rules or the standard flow ($kind), and writes nothing', async (actor) => {
    const done = await column('Done')
    const version = await readChangeSeq(store)

    for (const attempt of [
      async () => await setColumnFlowRules(store, done.id, { allowedFrom: null, wipLimit: null }, actor),
      async () => await applyStandardFlow(store, WORKSPACE.id, actor),
    ]) {
      const failure = await refusal(attempt)
      expect(failure.code).toBe('board_column_rules_requires_user')
      expect(failure.details).toMatchObject({ actorKind: actor.kind })
    }
    expect(await readChangeSeq(store)).toBe(version)
    expect(readFlowRules(await column('Done')).allowedFrom).toEqual([(await column('In Review')).id])
  })

  it('refuses a limit under 1 or not whole, a column of another board, and the column itself, before writing anything', async () => {
    await ensureDefaultColumns(store, OTHER.id)
    const inReview = await column('In Review')
    const version = await readChangeSeq(store)

    for (const wipLimit of [0, -1, 1.5]) {
      const failure = await refusal(async () => await setColumnFlowRules(store, inReview.id, { allowedFrom: null, wipLimit }, USER))
      expect(failure).toMatchObject({ code: 'board_flow_rule_invalid', details: { statusId: inReview.id, wipLimit } })
    }
    const elsewhere = await column('In Progress', OTHER.id)
    for (const allowedFrom of [[elsewhere.id], [inReview.id]]) {
      const failure = await refusal(async () => await setColumnFlowRules(store, inReview.id, { allowedFrom, wipLimit: null }, USER))
      expect(failure).toMatchObject({ code: 'board_flow_rule_invalid', details: { statusId: inReview.id, allowedFrom } })
    }
    expect((await refusal(async () => await setColumnFlowRules(store, 'no-such-column', { allowedFrom: null, wipLimit: 1 }, USER))).code).toBe('issue_status_not_found')
    expect(await readChangeSeq(store)).toBe(version)
  })

  it('refuses a limit past the largest 32-bit integer, writing nothing; that largest one passes', async () => {
    const inReview = await column('In Review')
    const version = await readChangeSeq(store)

    for (const wipLimit of [2_147_483_648, 3_000_000_000, 1e20]) {
      const failure = await refusal(async () => await setColumnFlowRules(store, inReview.id, { allowedFrom: null, wipLimit }, USER))
      expect(failure).toMatchObject({ code: 'board_flow_rule_invalid', details: { statusId: inReview.id, wipLimit } })
    }
    expect(await readChangeSeq(store)).toBe(version)
    expect(readFlowRules(await column('In Review')).wipLimit).toBeNull()

    expect(readFlowRules(await setColumnFlowRules(store, inReview.id, { allowedFrom: null, wipLimit: 2_147_483_647 }, USER)).wipLimit).toBe(2_147_483_647)
  })

  it('applies the standard flow to a board that predates it, leaving Done\'s limit and every other column alone', async () => {
    const [toDo, inProgress, done] = [await column('To Do'), await column('In Progress'), await column('Done')]
    await setColumnFlowRules(store, done.id, { allowedFrom: null, wipLimit: 5 }, USER)
    await setColumnFlowRules(store, inProgress.id, { allowedFrom: [toDo.id], wipLimit: 3 }, USER)
    const qa = await addColumn(store, WORKSPACE.id, { name: 'QA', category: 'started', position: { after: 'in_review' } }, USER)

    const columns = await applyStandardFlow(store, WORKSPACE.id, USER)

    const byId = new Map(columns.map(each => [each.id, each]))
    expect(readFlowRules(byId.get(done.id)!)).toEqual({ allowedFrom: [(await column('In Review')).id, qa.id], wipLimit: 5 })
    expect(readFlowRules(byId.get(inProgress.id)!)).toEqual({ allowedFrom: [toDo.id], wipLimit: 3 })
  })

  it('refuses the standard flow on a board with nothing for Done to take cards from', async () => {
    await applyColumnTemplate(store, 'simple-board', COLUMN_TEMPLATES.simple, { mode: 'seed' })

    const failure = await refusal(async () => await applyStandardFlow(store, 'simple-board', USER))

    expect(failure).toMatchObject({ code: 'issue_status_not_found', details: { workspaceId: 'simple-board', statusName: 'In Review' } })
  })

  it('takes a deleted column out of every list, and a list it empties stays empty rather than open to every column', async () => {
    const [backlog, toDo, canceled] = [await column('Backlog'), await column('To Do'), await column('Canceled')]
    await setColumnFlowRules(store, canceled.id, { allowedFrom: [backlog.id, toDo.id], wipLimit: null }, USER)

    await removeColumn(store, WORKSPACE.id, 'In Review', {}, USER)
    await deleteColumn(store, backlog.id, undefined, USER)

    expect(readFlowRules(await column('Done'))).toEqual({ allowedFrom: [], wipLimit: null })
    expect(readFlowRules(await column('Canceled'))).toEqual({ allowedFrom: [toDo.id], wipLimit: null })
  })
})

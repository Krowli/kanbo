import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { BoardStore } from '../board-store'
import { BoardError } from '../domain/errors'
import type { BoardWorkspaceIdentity } from '../domain/numbering'
import type { TestBoardStore } from '../testing/board-stores'
import { BOARD_STORE_FACTORIES } from '../testing/board-stores'
import { bulkUpdateCards } from './card-batch'
import { createCard, moveCard, updateCard } from './cards'
import { readChangeSeq } from './change-seq'
import { ensureDefaultColumns, requireColumn, setColumnEntryRules, setColumnFlowRules } from './columns'
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

describe.each(BOARD_STORE_FACTORIES)('flow rules at a column\'s door on $name', (factory) => {
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

  /** A card a person put in a column, warned or not. */
  async function cardIn(title: string, columnName: string) {
    return await createCard(store, { workspace: WORKSPACE, title, statusName: columnName }, USER)
  }

  it('refuses an agent putting a card in a column it does not accept cards from, and changes nothing', async () => {
    const done = await column('Done')
    const card = await cardIn('Card', 'In Progress')
    const version = await readChangeSeq(store)

    const failure = await refusal(async () => await moveCard(store, card.id, 'done', AGENT))

    expect(failure.code).toBe('board_column_rules_unmet')
    expect(failure.details).toEqual({
      issueId: card.id,
      column: 'Done',
      statusId: done.id,
      unmet: [{ rule: 'allowed_from', reason: 'not_allowed_from', detail: 'Done accepts cards from In Review only' }],
    })
    expect(await readChangeSeq(store)).toBe(version)
    expect((await store.issues.findById(card.id))?.statusId).toBe(card.statusId)
  })

  it('lets an agent in from a column the list names, and a person in from anywhere, warned', async () => {
    const reviewed = await cardIn('Reviewed', 'In Review')
    expect((await moveCard(store, reviewed.id, 'done', AGENT)).unmetRules).toBeUndefined()

    const skipped = await cardIn('Skipped review', 'In Progress')
    const moved = await moveCard(store, skipped.id, 'done', USER)
    expect(moved.statusId).toBe((await column('Done')).id)
    expect(moved.unmetRules).toEqual([{ rule: 'allowed_from', reason: 'not_allowed_from', detail: 'Done accepts cards from In Review only' }])
  })

  it('holds a new card to where its column accepts cards from: a card being created comes from no column', async () => {
    const failure = await refusal(async () => await createCard(store, { workspace: WORKSPACE, title: 'Straight to Done', statusName: 'done' }, AGENT))

    expect(failure.details).toMatchObject({ issueId: null, column: 'Done', unmet: [{ rule: 'allowed_from' }] })
    expect(await store.issues.listByWorkspace(WORKSPACE.id)).toEqual([])
  })

  it('does not check a card that stays in its column', async () => {
    const card = await cardIn('Already done', 'Done')

    expect((await updateCard(store, card.id, { statusId: (await column('Done')).id, title: 'Renamed' }, AGENT)).title).toBe('Renamed')
  })

  it('counts the cards already in a column against its limit, not the card entering', async () => {
    const inProgress = await column('In Progress')
    await setColumnFlowRules(store, inProgress.id, { allowedFrom: null, wipLimit: 2 }, USER)
    await cardIn('First', 'In Progress')
    const second = await cardIn('Second', 'To Do')
    const third = await cardIn('Third', 'To Do')

    expect((await moveCard(store, second.id, 'in_progress', AGENT)).statusId).toBe(inProgress.id)
    const failure = await refusal(async () => await moveCard(store, third.id, 'in_progress', AGENT))
    expect(failure.details).toMatchObject({ unmet: [{ rule: 'wip_limit', reason: 'column_full', detail: 'In Progress holds 2 of 2' }] })
  })

  it('holds a bulk move to the limit all or nothing for an agent, and warns a person about each card past it', async () => {
    const inProgress = await column('In Progress')
    await setColumnFlowRules(store, inProgress.id, { allowedFrom: null, wipLimit: 2 }, USER)
    await cardIn('Already there', 'In Progress')
    const moving = [(await cardIn('A', 'To Do')).id, (await cardIn('B', 'To Do')).id, (await cardIn('C', 'To Do')).id]
    const version = await readChangeSeq(store)

    const failure = await refusal(async () => await bulkUpdateCards(store, moving, { statusId: inProgress.id }, AGENT))
    expect(failure.code).toBe('board_column_rules_unmet')
    expect(await readChangeSeq(store)).toBe(version)
    expect((await store.issues.listByIds(moving)).every(card => card.statusId !== inProgress.id)).toBe(true)

    const result = await bulkUpdateCards(store, moving, { statusId: inProgress.id }, USER)
    expect(result.updated).toBe(3)
    expect(result.unmetRules?.flatMap(entry => entry.unmet.map(item => item.detail)).sort())
      .toEqual(['In Progress holds 2 of 2', 'In Progress holds 3 of 2'])
  })

  it('refuses a card moved in from another board when the column names where its cards come from', async () => {
    await ensureDefaultColumns(store, OTHER.id)
    const card = await cardIn('Moving boards', 'In Review')

    const failure = await refusal(async () => await updateCard(store, card.id, { workspaceId: OTHER.id, statusName: 'Done' }, AGENT))

    expect(failure.details).toMatchObject({ column: 'Done', statusId: (await column('Done', OTHER.id)).id, unmet: [{ rule: 'allowed_from' }] })
  })

  it('says entry rules and flow rules in one refusal, entry rules first', async () => {
    await setColumnEntryRules(store, WORKSPACE.id, 'Done', ['approved'], USER)
    const card = await cardIn('Card', 'In Progress')

    const failure = await refusal(async () => await moveCard(store, card.id, 'done', AGENT))

    expect((failure.details?.unmet as { rule: string }[]).map(item => item.rule)).toEqual(['approved', 'allowed_from'])
  })
})

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { BoardStore } from '../board-store'
import { DEFAULT_STATUSES } from '../domain/status-name'
import type { TestBoardStore } from '../testing/board-stores'
import { BOARD_STORE_FACTORIES } from '../testing/board-stores'
import { readChangeSeq } from './change-seq'
import { COLUMN_TEMPLATE_IDS, COLUMN_TEMPLATES } from '../domain/column-templates'
import { createBoardOps } from '.'
import type { BoardActor } from './types'
import { addStandardColumns, ensureDefaultColumns, listColumns } from './columns'

describe.each(BOARD_STORE_FACTORIES)('board columns on $name', (factory) => {
  let board: TestBoardStore
  let store: BoardStore

  beforeEach(async () => {
    board = await factory.open([{ id: 'workspace' }])
    store = board.store
  })

  afterEach(async () => {
    await board.dispose()
  })

  it('seeds the six standard columns, In Review fourth, each with its description', async () => {
    await ensureDefaultColumns(store, 'workspace')

    const columns = await listColumns(store, 'workspace')
    expect(columns.map(column => column.name)).toEqual(['Backlog', 'To Do', 'In Progress', 'In Review', 'Done', 'Canceled'])
    expect(columns[3]).toMatchObject({ name: 'In Review', category: 'started' })
    expect(columns.map(column => column.description)).toEqual(DEFAULT_STATUSES.map(status => status.description))
    expect(columns.map(column => column.order)).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('seeds nothing on a board that already has columns', async () => {
    await store.statuses.create({ id: 'mine', workspaceId: 'workspace', name: 'Mine', order: 0 })

    await ensureDefaultColumns(store, 'workspace')

    expect((await listColumns(store, 'workspace')).map(column => column.name)).toEqual(['Mine'])
  })

  it('adds only the missing standard columns, each after the standard column before it, keeping the custom order', async () => {
    await store.statuses.create({ id: 'backlog', workspaceId: 'workspace', name: 'Backlog', order: 0 })
    await store.statuses.create({ id: 'mine', workspaceId: 'workspace', name: 'Triage mine', order: 1 })
    await store.statuses.create({ id: 'done', workspaceId: 'workspace', name: 'Done', order: 2 })

    const result = await addStandardColumns(store, 'workspace')

    expect(result.added).toEqual(['To Do', 'In Progress', 'In Review', 'Canceled'])
    expect(result.statuses.map(column => column.name)).toEqual([
      'Backlog',
      'To Do',
      'In Progress',
      'In Review',
      'Triage mine',
      'Done',
      'Canceled',
    ])
    expect(result.statuses.map(column => column.order)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(result.statuses.find(column => column.name === 'To Do')?.description)
      .toBe(DEFAULT_STATUSES[1].description)
  })

  it('writes nothing the second time, so the board version stays where it was', async () => {
    await addStandardColumns(store, 'workspace')
    const afterFirst = await readChangeSeq(store)
    const before = await listColumns(store, 'workspace')

    const result = await addStandardColumns(store, 'workspace')

    expect(result.added).toEqual([])
    expect(result.statuses).toEqual(before)
    expect(await readChangeSeq(store)).toBe(afterFirst)
  })

  it.each(COLUMN_TEMPLATE_IDS)('seeds the %s template into an empty board: exactly its columns, in order, with descriptions', async (id) => {
    const result = await createBoardOps(store).applyColumnTemplate('workspace', COLUMN_TEMPLATES[id], { mode: 'seed' })

    const columns = await listColumns(store, 'workspace')
    const expected = COLUMN_TEMPLATES[id]
    expect(result.added).toEqual(expected.map(column => column.name))
    expect(columns.map(({ name, description, category, color }) => ({ name, description, category, color }))).toEqual(expected)
    expect(columns.map(column => column.order)).toEqual(expected.map((_, index) => index))
  })

  it('seeds no template into a board that already has columns', async () => {
    await store.statuses.create({ id: 'mine', workspaceId: 'workspace', name: 'Mine', order: 0 })

    const result = await createBoardOps(store).applyColumnTemplate('workspace', COLUMN_TEMPLATES.simple, { mode: 'seed' })

    expect(result.added).toEqual([])
    expect((await listColumns(store, 'workspace')).map(column => column.name)).toEqual(['Mine'])
  })

  describe('structure changes, a person\'s to make', () => {
    const PERSON: BoardActor = { kind: 'user', id: 'ada' }
    const AGENT: BoardActor = { kind: 'agent', id: 'claude' }
    const WORKSPACE = { id: 'workspace', identifier: 'WOR', name: 'Workspace' }
    const names = async (): Promise<string[]> => (await listColumns(store, 'workspace')).map(column => column.name)
    const ops = () => createBoardOps(store)

    beforeEach(async () => {
      await ensureDefaultColumns(store, 'workspace')
    })

    async function cardsIn(columnName: string): Promise<string[]> {
      const column = await ops().requireColumn('workspace', columnName)
      return (await store.issues.listInBoardOrder('workspace')).filter(card => card.statusId === column.id).map(card => card.id)
    }

    it('renames a column, and its slug follows the name', async () => {
      const renamed = await ops().renameColumn('workspace', 'in_review', 'Code Review', PERSON)

      expect(renamed.name).toBe('Code Review')
      expect(await names()).toEqual(['Backlog', 'To Do', 'In Progress', 'Code Review', 'Done', 'Canceled'])
      expect(await ops().findColumn('workspace', 'code_review')).toMatchObject({ id: renamed.id })
    })

    it('refuses a name whose slug another column has, and changes nothing', async () => {
      const before = await readChangeSeq(store)

      await expect(ops().renameColumn('workspace', 'backlog', 'in-progress', PERSON))
        .rejects.toMatchObject({ code: 'board_column_name_taken', details: { takenBy: 'In Progress' } })
      expect(await names()).toEqual(['Backlog', 'To Do', 'In Progress', 'In Review', 'Done', 'Canceled'])
      expect(await readChangeSeq(store)).toBe(before)
    })

    it('refuses renaming To Do away from its slug, and allows a new spelling of it', async () => {
      await expect(ops().renameColumn('workspace', 'To Do', 'Ready', PERSON))
        .rejects.toMatchObject({ code: 'board_column_ready_protected' })

      await ops().renameColumn('workspace', 'to_do', 'To-do', PERSON)
      expect(await names()).toContain('To-do')
    })

    it.each([
      ['first', ['Done', 'Backlog', 'To Do', 'In Progress', 'In Review', 'Canceled']],
      ['last', ['Backlog', 'To Do', 'In Progress', 'In Review', 'Canceled', 'Done']],
      [{ before: 'in_progress' }, ['Backlog', 'To Do', 'Done', 'In Progress', 'In Review', 'Canceled']],
      [{ after: 'backlog' }, ['Backlog', 'Done', 'To Do', 'In Progress', 'In Review', 'Canceled']],
    ] as const)('moves a column to %j', async (position, expected) => {
      const result = await ops().moveColumn('workspace', 'done', position, PERSON)

      expect(result.map(column => column.name)).toEqual(expected)
      expect(await names()).toEqual(expected)
      expect((await listColumns(store, 'workspace')).map(column => column.order)).toEqual([0, 1, 2, 3, 4, 5])
    })

    it('writes nothing for a move that changes nothing', async () => {
      const before = await readChangeSeq(store)

      await ops().moveColumn('workspace', 'canceled', 'last', PERSON)
      await ops().moveColumn('workspace', 'done', { before: 'canceled' }, PERSON)

      expect(await readChangeSeq(store)).toBe(before)
    })

    it('refuses to remove a column that holds cards without a column to move them to, and leaves the cards', async () => {
      const card = await ops().createCard({ workspace: WORKSPACE, title: 'Check', statusName: 'In Review' }, PERSON)
      const before = await readChangeSeq(store)

      await expect(ops().removeColumn('workspace', 'in_review', {}, PERSON))
        .rejects.toMatchObject({ code: 'board_column_not_empty', details: { cardCount: 1 } })
      expect(await names()).toContain('In Review')
      expect(await cardsIn('in_review')).toEqual([card.id])
      expect(await readChangeSeq(store)).toBe(before)
    })

    it('removes a column and moves its cards in one write, each card\'s history recording the move', async () => {
      const first = await ops().createCard({ workspace: WORKSPACE, title: 'One', statusName: 'In Review' }, PERSON)
      const second = await ops().createCard({ workspace: WORKSPACE, title: 'Two', statusName: 'In Review' }, PERSON)
      const before = await readChangeSeq(store)

      const result = await ops().removeColumn('workspace', 'In Review', { moveCardsTo: 'to_do' }, PERSON)

      expect(result).toMatchObject({ removed: { name: 'In Review' }, movedCards: 2, movedTo: { name: 'To Do' } })
      expect(await names()).toEqual(['Backlog', 'To Do', 'In Progress', 'Done', 'Canceled'])
      expect((await cardsIn('to_do')).sort()).toEqual([first.id, second.id].sort())
      expect(await readChangeSeq(store)).toBe(before + 1)
      const toDo = await ops().requireColumn('workspace', 'to_do')
      const changes = (await store.fieldChanges.listByIssue(first.id)).filter(change => change.field === 'statusId')
      expect(changes.at(-1)).toMatchObject({ toValue: toDo.id })
    })

    it('removes an empty column without a target', async () => {
      const result = await ops().removeColumn('workspace', 'canceled', {}, PERSON)

      expect(result).toMatchObject({ movedCards: 0, movedTo: null })
      expect(await names()).not.toContain('Canceled')
    })

    it('never removes To Do, and refuses moving cards into the column being removed', async () => {
      await expect(ops().removeColumn('workspace', 'to_do', { moveCardsTo: 'backlog' }, PERSON))
        .rejects.toMatchObject({ code: 'board_column_ready_protected' })
      await expect(ops().removeColumn('workspace', 'done', { moveCardsTo: 'Done' }, PERSON))
        .rejects.toMatchObject({ code: 'board_column_remove_target_invalid' })
      expect(await names()).toEqual(['Backlog', 'To Do', 'In Progress', 'In Review', 'Done', 'Canceled'])
    })

    it('adds only the template columns the board lacks, and writes nothing the second time', async () => {
      const first = await ops().applyColumnTemplate('workspace', COLUMN_TEMPLATES['review-qa'], { mode: 'add-missing', actor: PERSON })
      const afterFirst = await readChangeSeq(store)
      const second = await ops().applyColumnTemplate('workspace', COLUMN_TEMPLATES['review-qa'], { mode: 'add-missing', actor: PERSON })

      expect(first.added).toEqual(['QA'])
      expect(await names()).toEqual(['Backlog', 'To Do', 'In Progress', 'In Review', 'QA', 'Done', 'Canceled'])
      expect(second.added).toEqual([])
      expect(await readChangeSeq(store)).toBe(afterFirst)
    })

    it('refuses every structure change from anyone but a person', async () => {
      const before = await readChangeSeq(store)
      const refused = { code: 'board_column_structure_requires_user' }

      await expect(ops().renameColumn('workspace', 'done', 'Shipped', AGENT)).rejects.toMatchObject(refused)
      await expect(ops().moveColumn('workspace', 'done', 'first', AGENT)).rejects.toMatchObject(refused)
      await expect(ops().removeColumn('workspace', 'canceled', {}, AGENT)).rejects.toMatchObject(refused)
      await expect(ops().applyColumnTemplate('workspace', COLUMN_TEMPLATES['review-qa'], { mode: 'add-missing', actor: AGENT }))
        .rejects.toMatchObject(refused)
      expect(await readChangeSeq(store)).toBe(before)
    })
  })
})

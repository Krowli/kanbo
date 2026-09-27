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

    it('holds a new name given through updateColumn to the rename rules, and to a person', async () => {
      const toDo = await ops().requireColumn('workspace', 'to_do')
      const backlog = await ops().requireColumn('workspace', 'backlog')
      const before = await readChangeSeq(store)

      await expect(ops().updateColumn(backlog.id, { name: 'in progress' }, PERSON))
        .rejects.toMatchObject({ code: 'board_column_name_taken', details: { takenBy: 'In Progress' } })
      await expect(ops().updateColumn(toDo.id, { name: 'Ready' }, PERSON))
        .rejects.toMatchObject({ code: 'board_column_ready_protected' })
      await expect(ops().updateColumn(backlog.id, { name: '  ' }, PERSON))
        .rejects.toMatchObject({ code: 'issue_status_name_empty' })
      await expect(ops().updateColumn(backlog.id, { name: 'Ideas' }, AGENT))
        .rejects.toMatchObject({ code: 'board_column_structure_requires_user' })
      expect(await readChangeSeq(store)).toBe(before)

      // The same name, a description, a new spelling of To Do: all fine.
      await ops().updateColumn(backlog.id, { name: 'Backlog', description: 'Later' }, AGENT)
      await ops().updateColumn(toDo.id, { name: 'To-do' }, PERSON)
      expect(await names()).toEqual(['Backlog', 'To-do', 'In Progress', 'In Review', 'Done', 'Canceled'])
    })

    it('deletes only an empty column that is not To Do, and numbers the rest 0..n-1', async () => {
      const card = await ops().createCard({ workspace: WORKSPACE, title: 'Check', statusName: 'In Review' }, PERSON)
      const inReview = await ops().requireColumn('workspace', 'in_review')
      const toDo = await ops().requireColumn('workspace', 'to_do')
      const before = await readChangeSeq(store)

      await expect(ops().deleteColumn(inReview.id))
        .rejects.toMatchObject({ code: 'board_column_not_empty', details: { cardCount: 1 } })
      await expect(ops().deleteColumn(toDo.id)).rejects.toMatchObject({ code: 'board_column_ready_protected' })
      expect(await cardsIn('in_review')).toEqual([card.id])
      expect(await readChangeSeq(store)).toBe(before)

      await ops().deleteColumn((await ops().requireColumn('workspace', 'backlog')).id)
      const left = await listColumns(store, 'workspace')
      expect(left.map(column => column.name)).toEqual(['To Do', 'In Progress', 'In Review', 'Done', 'Canceled'])
      expect(left.map(column => column.order)).toEqual([0, 1, 2, 3, 4])
      expect(await readChangeSeq(store)).toBe(before + 1)
    })

    it('refuses create, update, delete, reorder and add-standard from an actor who is not a person, and allows them with none', async () => {
      const canceled = await ops().requireColumn('workspace', 'canceled')
      const ids = (await listColumns(store, 'workspace')).map(column => column.id)
      const before = await readChangeSeq(store)
      const refused = { code: 'board_column_structure_requires_user' }

      await expect(ops().createColumn({ workspaceId: 'workspace', name: 'QA' }, AGENT)).rejects.toMatchObject(refused)
      await expect(ops().deleteColumn(canceled.id, undefined, AGENT)).rejects.toMatchObject(refused)
      await expect(ops().reorderColumns('workspace', ids.toReversed(), undefined, AGENT)).rejects.toMatchObject(refused)
      await expect(ops().addStandardColumns('workspace', undefined, AGENT)).rejects.toMatchObject(refused)
      expect(await readChangeSeq(store)).toBe(before)

      await ops().reorderColumns('workspace', ids.toReversed())
      await ops().deleteColumn(canceled.id)
      expect((await ops().addStandardColumns('workspace', undefined, PERSON)).added).toEqual(['Canceled'])
    })

    it('gives a column added after a removal an order no other column has', async () => {
      await ops().removeColumn('workspace', 'backlog', {}, PERSON)
      await ops().createColumn({ workspaceId: 'workspace', name: 'QA' }, PERSON)
      // A board whose orders have a gap anyway (written by an older kanbo).
      const done = await ops().requireColumn('workspace', 'done')
      await store.statuses.update(done.id, { order: 40 })
      const blocked = await ops().createColumn({ workspaceId: 'workspace', name: 'Blocked' }, PERSON)

      const columns = await listColumns(store, 'workspace')
      expect(new Set(columns.map(column => column.order)).size).toBe(columns.length)
      expect(blocked.order).toBe(41)
      expect(columns.map(column => column.name)).toEqual(['To Do', 'In Progress', 'In Review', 'Canceled', 'QA', 'Done', 'Blocked'])
    })

    it('moves the cards of a removed column as a person\'s move does: waiting cards keep waiting, unmet entry rules come back', async () => {
      const card = await ops().createCard({ workspace: WORKSPACE, title: 'Check', statusName: 'In Review' }, PERSON)
      await ops().waitApproval(card.id, {}, PERSON)
      await ops().setColumnEntryRules('workspace', 'done', ['pull_request_linked'], PERSON)

      const result = await ops().removeColumn('workspace', 'in_review', { moveCardsTo: 'done' }, PERSON)

      expect(result.unmetRules).toEqual([{ issueId: card.id, unmet: [expect.objectContaining({ rule: 'pull_request_linked' })] }])
      expect(await store.issues.findById(card.id)).toMatchObject({ waitingFor: 'human' })
      expect(await cardsIn('done')).toEqual([card.id])
    })

    it('refuses the whole removal when a card lands in the column after its cards were read', async () => {
      const moving = await ops().createCard({ workspace: WORKSPACE, title: 'Moving', statusName: 'In Review' }, PERSON)
      const late = await ops().createCard({ workspace: WORKSPACE, title: 'Late', statusName: 'Backlog' }, PERSON)
      const inReview = await ops().requireColumn('workspace', 'in_review')
      const before = await readChangeSeq(store)
      // Another writer puts a card in the column right after removeColumn listed its cards.
      const racing: BoardStore = {
        ...store,
        transaction: async (fn, options) => await store.transaction(async (tx) => {
          let reads = 0
          const issues = {
            ...tx.issues,
            listByWorkspace: async (workspaceId: string) => {
              const rows = await tx.issues.listByWorkspace(workspaceId)
              if (++reads === 1) {
                await tx.issues.update(late.id, { statusId: inReview.id })
              }
              return rows
            },
          }
          return await fn({ ...tx, issues })
        }, options),
      }

      await expect(createBoardOps(racing).removeColumn('workspace', 'in_review', { moveCardsTo: 'to_do' }, PERSON))
        .rejects.toMatchObject({ code: 'board_column_not_empty', details: { cardCount: 1 } })
      expect(await names()).toContain('In Review')
      expect(await cardsIn('in_review')).toEqual([moving.id])
      expect(await cardsIn('backlog')).toEqual([late.id])
      expect(await readChangeSeq(store)).toBe(before)
    })

    it('adds a column at its place in one write, and refuses a name another column answers to', async () => {
      const before = await readChangeSeq(store)

      const qa = await ops().addColumn('workspace', { name: 'QA', description: 'Checked by hand' }, PERSON)
      expect(await readChangeSeq(store)).toBe(before + 1)
      expect(qa).toMatchObject({ name: 'QA', description: 'Checked by hand', category: 'unstarted' })
      await ops().addColumn('workspace', { name: 'Design', position: { after: 'backlog' } }, PERSON)
      await ops().addColumn('workspace', { name: 'Inbox', position: 'first' }, PERSON)

      const columns = await listColumns(store, 'workspace')
      expect(columns.map(column => column.name))
        .toEqual(['Inbox', 'Backlog', 'Design', 'To Do', 'In Progress', 'In Review', 'QA', 'Done', 'Canceled'])
      expect(columns.map(column => column.order)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])

      const afterAdds = await readChangeSeq(store)
      await expect(ops().addColumn('workspace', { name: ' qa ' }, PERSON)).rejects.toMatchObject({ code: 'board_column_name_taken' })
      await expect(ops().addColumn('workspace', { name: 'Later' }, AGENT)).rejects.toMatchObject({ code: 'board_column_structure_requires_user' })
      expect(await readChangeSeq(store)).toBe(afterAdds)
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

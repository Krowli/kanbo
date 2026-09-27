import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { BoardStore } from '../board-store'
import { BoardError } from '../domain/errors'
import type { BoardWorkspaceIdentity } from '../domain/numbering'
import type { TestBoardStore } from '../testing/board-stores'
import { BOARD_STORE_FACTORIES } from '../testing/board-stores'
import { approve, createCard, createCommentOnce, moveCard, returnCard, updateCard } from './cards'
import { readChangeSeq } from './change-seq'
import { createColumn, ensureDefaultColumns, requireColumn, setColumnEntryRules, updateColumn } from './columns'
import { enforceColumnEntryForCards } from './entry-rules'
import { linkPullRequest } from './pull-requests'
import { closeSprint, createMilestone } from './sprints'
import type { BoardActor } from './types'
import { BOARD_ACTOR } from './types'

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

describe.each(BOARD_STORE_FACTORIES)('column entry rules on $name', (factory) => {
  let board: TestBoardStore
  let store: BoardStore

  beforeEach(async () => {
    board = await factory.open([{ id: 'workspace', identifier: 'WOR' }, { id: 'other', identifier: 'OTH' }])
    store = board.store
    await ensureDefaultColumns(store, WORKSPACE.id)
  })

  afterEach(async () => {
    await board.dispose()
  })

  it('keeps the rules a column is given, on create, update and by name, and clears them', async () => {
    const created = await createColumn(store, { workspaceId: WORKSPACE.id, name: 'QA', entryRules: ['ci_green', 'pull_request_linked'] }, USER)
    expect(created.entryRules).toBe('["pull_request_linked","ci_green"]')

    const updated = await updateColumn(store, created.id, { entryRules: ['approved'] }, USER)
    expect(updated.entryRules).toBe('["approved"]')

    const named = await setColumnEntryRules(store, WORKSPACE.id, 'in-review', ['checklist_complete'], USER)
    expect(named).toMatchObject({ name: 'In Review', entryRules: '["checklist_complete"]' })

    expect((await setColumnEntryRules(store, WORKSPACE.id, 'In Review', null, USER)).entryRules).toBeNull()
    expect((await updateColumn(store, created.id, { entryRules: [] }, USER)).entryRules).toBeNull()
    // A patch that does not name the rules leaves them alone.
    await updateColumn(store, created.id, { entryRules: ['approved'] }, USER)
    expect((await updateColumn(store, created.id, { description: 'Checked by QA' }, USER)).entryRules).toBe('["approved"]')
  })

  it.each([AGENT, EXTERNAL])('lets only a person set, change or clear a column\'s rules ($kind)', async (actor) => {
    const column = await setColumnEntryRules(store, WORKSPACE.id, 'In Review', ['approved'], USER)
    const version = await readChangeSeq(store)

    for (const attempt of [
      async () => await setColumnEntryRules(store, WORKSPACE.id, 'In Review', null, actor),
      async () => await updateColumn(store, column.id, { entryRules: [] }, actor),
      async () => await updateColumn(store, column.id, { entryRules: ['ci_green'] }, actor),
    ]) {
      const failure = await refusal(attempt)
      expect(failure.code).toBe('board_column_rules_requires_user')
      expect(failure.details).toMatchObject({ actorKind: actor.kind })
    }

    expect(await readChangeSeq(store)).toBe(version)
    expect((await requireColumn(store, WORKSPACE.id, 'In Review')).entryRules).toBe('["approved"]')
    // A column's description stays open to them; adding a column at all is a
    // person's change to the board's structure, rules or none.
    expect((await updateColumn(store, column.id, { description: 'Checked' }, actor)).entryRules).toBe('["approved"]')
    for (const entryRules of [['ci_green'], null]) {
      const failure = await refusal(async () => await createColumn(store, { workspaceId: WORKSPACE.id, name: 'QA', entryRules }, actor))
      expect(failure.code).toBe('board_column_structure_requires_user')
    }
  })

  it('refuses an unknown rule before writing anything', async () => {
    const version = await readChangeSeq(store)

    const failure = await refusal(async () => await setColumnEntryRules(store, WORKSPACE.id, 'in-review', ['tests_pass'], USER))
    expect(failure.code).toBe('board_entry_rule_invalid')
    await refusal(async () => await createColumn(store, { workspaceId: WORKSPACE.id, name: 'QA', entryRules: ['nope'] }, USER))

    expect(await readChangeSeq(store)).toBe(version)
    expect((await requireColumn(store, WORKSPACE.id, 'in-review')).entryRules).toBeNull()
  })

  it('refuses an agent moving a card into a column whose rules it does not meet, by name, slug or id, and changes nothing', async () => {
    const column = await setColumnEntryRules(store, WORKSPACE.id, 'In Review', ['checklist_complete', 'pull_request_linked'], USER)
    const card = await createCard(store, { workspace: WORKSPACE, title: 'Card', description: '- [x] a\n- [ ] b' }, USER)
    const version = await readChangeSeq(store)

    for (const nameOrId of ['In Review', 'in_review', column.id]) {
      const failure = await refusal(async () => await moveCard(store, card.id, nameOrId, AGENT))
      expect(failure.code).toBe('board_column_rules_unmet')
      expect(failure.details).toEqual({
        issueId: card.id,
        column: 'In Review',
        statusId: column.id,
        unmet: [
          { rule: 'checklist_complete', reason: 'unchecked', detail: '1 of 2 unchecked', checked: 1, total: 2 },
          { rule: 'pull_request_linked', reason: 'no_pull_request', detail: 'no pull request linked' },
        ],
      })
    }
    await refusal(async () => await moveCard(store, card.id, 'in-review', EXTERNAL))
    await refusal(async () => await updateCard(store, card.id, { statusId: column.id }, { kind: 'provider-target', id: 'pt' }))

    expect(await readChangeSeq(store)).toBe(version)
    expect((await store.issues.findById(card.id))?.statusId).toBe(card.statusId)
    expect((await store.fieldChanges.listByIssue(card.id)).filter(change => change.field === 'statusId')).toEqual([])
  })

  it('lets a person move the card anyway, and hands back what it entered without', async () => {
    const column = await setColumnEntryRules(store, WORKSPACE.id, 'In Review', ['checklist_complete'], USER)
    const card = await createCard(store, { workspace: WORKSPACE, title: 'Card' }, USER)
    expect(card.unmetRules).toBeUndefined()

    const moved = await moveCard(store, card.id, 'in-review', USER)

    expect(moved.statusId).toBe(column.id)
    expect(moved.unmetRules).toEqual([{ rule: 'checklist_complete', reason: 'no_checklist', detail: 'no checklist in the description' }])
    expect((await store.issues.findById(card.id))?.statusId).toBe(column.id)
  })

  it('lets an agent in once the card meets every rule, and says nothing about rules then', async () => {
    await setColumnEntryRules(store, WORKSPACE.id, 'In Review', ['checklist_complete', 'pull_request_linked'], USER)
    const card = await createCard(store, { workspace: WORKSPACE, title: 'Card', description: '- [x] a\n- [ ] b' }, USER)
    await linkPullRequest(store, card.id, 'octo/repo#1', AGENT)

    // The description ticked off in the same update counts.
    const moved = await updateCard(store, card.id, { statusName: 'in review', description: '- [x] a\n- [x] b' }, AGENT)

    expect(moved.statusId).toBe((await requireColumn(store, WORKSPACE.id, 'in-review')).id)
    expect(moved).not.toHaveProperty('unmetRules')
  })

  it('does not check a card that is already in the column', async () => {
    const column = await requireColumn(store, WORKSPACE.id, 'backlog')
    const card = await createCard(store, { workspace: WORKSPACE, title: 'Card', statusId: column.id }, USER)
    await setColumnEntryRules(store, WORKSPACE.id, 'backlog', ['approved'], USER)

    const updated = await updateCard(store, card.id, { statusId: column.id, title: 'Renamed' }, AGENT)

    expect(updated).toMatchObject({ title: 'Renamed', statusId: column.id })
  })

  it('reads CI off the newest verdict across the card\'s linked pull requests only', async () => {
    await setColumnEntryRules(store, WORKSPACE.id, 'In Review', ['ci_green'], USER)
    const card = await createCard(store, { workspace: WORKSPACE, title: 'Card' }, USER)
    const fact = async (dedupeKey: string) => await createCommentOnce(store, {
      issueId: card.id,
      authorKind: 'system.pr',
      content: dedupeKey,
      dedupeKey,
      actor: BOARD_ACTOR,
    })
    const unmet = async () => (await refusal(async () => await moveCard(store, card.id, 'in-review', AGENT))).details?.unmet

    // A green verdict for a pull request the card does not name is not the card's.
    await fact('ci:octo/repo#9@aaa:green')
    expect(await unmet()).toEqual([{ rule: 'ci_green', reason: 'no_ci', detail: 'no CI result yet' }])

    await linkPullRequest(store, card.id, 'Octo/Repo#1', AGENT)
    expect(await unmet()).toEqual([{ rule: 'ci_green', reason: 'no_ci', detail: 'no CI result yet' }])

    await fact('ci:octo/repo#1@bbb:green')
    await linkPullRequest(store, card.id, 'octo/other#2', AGENT)
    await fact('ci:octo/other#2@ccc:red')
    expect(await unmet()).toEqual([{ rule: 'ci_green', reason: 'ci_red', detail: 'CI is red' }])

    await fact('ci:octo/repo#1@ddd:green')
    expect((await moveCard(store, card.id, 'in-review', AGENT)).unmetRules).toBeUndefined()
  })

  it('wants a person\'s approval, which only a person can give', async () => {
    await setColumnEntryRules(store, WORKSPACE.id, 'Done', ['approved'], USER)
    const card = await createCard(store, { workspace: WORKSPACE, title: 'Card' }, USER)
    expect((await refusal(async () => await moveCard(store, card.id, 'done', AGENT))).details?.unmet)
      .toEqual([{ rule: 'approved', reason: 'not_approved', detail: 'not approved by a person' }])

    await approve(store, card.id, {}, USER)

    expect((await moveCard(store, card.id, 'done', AGENT)).statusId).toBe((await requireColumn(store, WORKSPACE.id, 'done')).id)
  })

  it('holds a new card to the rules of the column it is created in', async () => {
    const column = await setColumnEntryRules(store, WORKSPACE.id, 'To Do', ['checklist_complete'], USER)
    const version = await readChangeSeq(store)

    const failure = await refusal(async () => await createCard(store, { workspace: WORKSPACE, title: 'Card', statusName: 'to-do' }, AGENT))
    expect(failure.details).toMatchObject({ issueId: null, column: 'To Do', unmet: [{ rule: 'checklist_complete' }] })
    expect(await readChangeSeq(store)).toBe(version)
    expect(await store.issues.listByWorkspace(WORKSPACE.id)).toEqual([])

    const ticked = await createCard(store, { workspace: WORKSPACE, title: 'Ticked', statusId: column.id, description: '- [x] spec' }, AGENT)
    expect(ticked.unmetRules).toBeUndefined()

    const byPerson = await createCard(store, { workspace: WORKSPACE, title: 'Mine', statusName: 'To Do' }, USER)
    expect(byPerson).toMatchObject({ statusId: column.id, unmetRules: [{ rule: 'checklist_complete', reason: 'no_checklist', detail: 'no checklist in the description' }] })
  })

  it('holds a bulk status change to the column\'s rules, all or nothing for an agent', async () => {
    const column = await setColumnEntryRules(store, WORKSPACE.id, 'In Review', ['checklist_complete'], USER)
    const ready = await createCard(store, { workspace: WORKSPACE, title: 'Ready', description: '- [x] a' }, USER)
    const notReady = await createCard(store, { workspace: WORKSPACE, title: 'Not ready', description: '- [ ] a' }, USER)
    const there = await createCard(store, { workspace: WORKSPACE, title: 'There', statusId: column.id }, USER)

    const failure = await refusal(async () => await enforceColumnEntryForCards(store, [ready.id, notReady.id], column.id, AGENT))
    expect(failure.details).toMatchObject({ issueId: notReady.id, unmet: [{ detail: '1 of 1 unchecked' }] })

    expect(await enforceColumnEntryForCards(store, [ready.id, there.id], column.id, AGENT)).toEqual([])
    expect(await enforceColumnEntryForCards(store, [ready.id, notReady.id, there.id], column.id, USER))
      .toEqual([{ issueId: notReady.id, unmet: [{ rule: 'checklist_complete', reason: 'unchecked', detail: '1 of 1 unchecked', checked: 0, total: 1 }] }])
  })

  it('does not check the board\'s own transitions: a return, a sprint close', async () => {
    const card = await createCard(store, { workspace: WORKSPACE, title: 'Card', statusName: 'Done' }, USER)
    await setColumnEntryRules(store, WORKSPACE.id, 'In Review', ['approved', 'ci_green'], USER)

    // A person sends it back into a ruled column.
    const returned = await returnCard(store, card.id, { comment: 'Not yet' }, USER)
    expect(returned.card.statusId).toBe((await requireColumn(store, WORKSPACE.id, 'in-review')).id)

    // A sprint close carries it on without touching its column.
    const sprint = await createMilestone(store, { workspaceId: WORKSPACE.id, title: 'S1' })
    const next = await createMilestone(store, { workspaceId: WORKSPACE.id, title: 'S2' })
    await updateCard(store, card.id, { milestoneId: sprint.id }, USER)
    expect(await closeSprint(store, sprint.id, { carryTo: next.id }, USER)).toMatchObject({ carried: 1 })
  })

  it('checks the first column a card lands in when it moves to another workspace (ruling 6-7)', async () => {
    const card = await createCard(store, { workspace: WORKSPACE, title: 'Card' }, USER)
    await ensureDefaultColumns(store, OTHER.id)
    const first = await setColumnEntryRules(store, OTHER.id, 'Backlog', ['checklist_complete'], USER)

    const failure = await refusal(async () => await updateCard(store, card.id, { workspaceId: OTHER.id }, AGENT))
    expect(failure.code).toBe('board_column_rules_unmet')
    expect((await store.issues.findById(card.id))?.workspaceId).toBe(WORKSPACE.id)

    const moved = await updateCard(store, card.id, { workspaceId: OTHER.id }, USER)
    expect(moved.statusId).toBe(first.id)
    expect(moved.unmetRules).toEqual([{ rule: 'checklist_complete', reason: 'no_checklist', detail: 'no checklist in the description' }])
  })
})

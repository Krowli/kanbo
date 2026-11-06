import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BoardStore } from '../board-store'
import type { BoardWorkspaceIdentity } from '../domain/numbering'
import { createCard } from '../ops/cards'
import { readChangeSeq } from '../ops/change-seq'
import { ensureDefaultColumns, requireColumn, setColumnEntryRules } from '../ops/columns'
import type { BoardActor } from '../ops/types'
import { createSqliteBoardStore } from '../sqlite/board-store.sqlite'
import type { TestBoardDatabase } from '../testing/board-database'
import { createTestBoardDatabase, seedHostWorkspace } from '../testing/board-database'
import { createPlacementActor, describeColumnRulesRefusal } from './actor'
import type { BoardSession } from './command'
import { openBoardSession } from './command'
import { registerColumnsCommands } from './commands/columns'
import { describeFailure } from './failure'

const WORKSPACE: BoardWorkspaceIdentity = { id: 'workspace', identifier: 'WOR', name: 'Workspace' }
const USER: BoardActor = { kind: 'user', id: '__self__' }

/** The variable that marks a shell as an agent's. */
const AGENT_SHELL = ['KANBO_ACTOR_KIND']

describe('column entry rules from a terminal', () => {
  let board: TestBoardDatabase
  let store: BoardStore
  let printed: string[]

  beforeEach(async () => {
    board = await createTestBoardDatabase()
    seedHostWorkspace(board, WORKSPACE.id, WORKSPACE.identifier)
    store = createSqliteBoardStore({ database: () => board.database })
    await ensureDefaultColumns(store, WORKSPACE.id)
    for (const name of [...AGENT_SHELL, 'KANBO_DB_PATH', 'KANBO_WORKSPACE_ID']) {
      vi.stubEnv(name, undefined)
    }
    printed = []
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    board.dispose()
  })

  async function run(argv: string[]): Promise<void> {
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      printed.push(line)
    })
    const program = new Command().exitOverride()
    registerColumnsCommands(program)
    await program.parseAsync([...argv, '--db', board.path, '--workspace', WORKSPACE.id], { from: 'user' })
  }

  /**
   * What the card commands did — through the board operations, as the actor a
   * placement is filed under: a person's terminal places for them (rules warn),
   * an agent's shell does not (rules refuse).
   */
  async function place<T>(body: (session: BoardSession) => Promise<T>): Promise<T> {
    const session = await openBoardSession({ db: board.path, workspace: WORKSPACE.id }, 'write')
    try {
      return await body(session)
    }
    finally {
      await session.close()
    }
  }

  it('sets a column\'s rules in a person\'s terminal, lists them, and clears them', async () => {
    await run(['columns', 'rules', 'in_review', '--require', 'ci_green, pull_request_linked'])
    expect((await requireColumn(store, WORKSPACE.id, 'in-review')).entryRules).toBe('["pull_request_linked","ci_green"]')

    printed = []
    await run(['columns', 'list'])
    expect(printed.join('\n')).toContain('In Review — Work done; being checked, or waiting for a person [requires: pull_request_linked, ci_green]')

    await run(['columns', 'rules', 'in_review', '--clear'])
    expect((await requireColumn(store, WORKSPACE.id, 'in-review')).entryRules).toBeNull()
  })

  it.each(AGENT_SHELL)('refuses setting rules in a shell started for an agent (%s)', async (variable) => {
    const before = await readChangeSeq(store)
    vi.stubEnv(variable, variable === 'KANBO_ACTOR_KIND' ? 'agent' : 'session-1')

    const refusal = expect.objectContaining({
      exitCode: 4,
      message: describeColumnRulesRefusal('KANBO_ACTOR_KIND=agent', ['columns', 'rules', 'in_review', '--clear', '--db', board.path, '--workspace', WORKSPACE.id]),
    })
    expect(describeColumnRulesRefusal('KANBO_ACTOR_KIND=agent', ['columns', 'rules', 'x'])).toContain('(KANBO_ACTOR_KIND=agent)')
    await expect(run(['columns', 'rules', 'in_review', '--clear'])).rejects.toThrowError(refusal)

    expect(await readChangeSeq(store)).toBe(before)
  })

  it('wants exactly one of --require and --clear, and only known rules', async () => {
    await expect(run(['columns', 'rules', 'in_review'])).rejects.toThrowError(expect.objectContaining({ exitCode: 1 }))
    await expect(run(['columns', 'rules', 'in_review', '--require', 'ci_green', '--clear']))
      .rejects
      .toThrowError(expect.objectContaining({ exitCode: 1, message: 'Pass --require or --clear, not both.' }))
    const failure = await run(['columns', 'rules', 'in_review', '--require', 'tests_pass']).then(() => undefined, (error: unknown) => error)
    expect(describeFailure(failure).message).toContain('board_entry_rule_invalid')
    expect((await requireColumn(store, WORKSPACE.id, 'in-review')).entryRules).toBeNull()
  })

  it.each(AGENT_SHELL)('refuses a move placed from an agent\'s shell with one line per unmet rule, exit 1 (%s)', async (variable) => {
    await setColumnEntryRules(store, WORKSPACE.id, 'In Review', ['checklist_complete', 'ci_green'], USER)
    const card = await createCard(store, {
      workspace: WORKSPACE,
      title: 'Card',
      description: '- [x] a\n- [ ] b\n- [ ] c\n- [x] d\n- [x] e',
    }, USER)
    vi.stubEnv(variable, variable === 'KANBO_ACTOR_KIND' ? 'agent' : 'session-1')

    const failure = await place(async session => await session.ops.moveCard(card.id, 'in_review', createPlacementActor())).then(() => undefined, (error: unknown) => error)

    expect(describeFailure(failure)).toEqual({
      exitCode: 1,
      code: 'board_column_rules_unmet',
      message: [
        `${card.id} can't go into "In Review" yet:`,
        '- checklist_complete: 2 of 5 unchecked',
        '- ci_green: no CI result yet',
        '  Next: fix what is listed, or ask a person to move the card  [board_column_rules_unmet]',
      ].join('\n'),
    })
    expect((await store.issues.findById(card.id))?.statusId).toBe(card.statusId)
  })

  it('moves a card for a person in their own terminal and reports one unmet rule per line (ruling 6-5)', async () => {
    await setColumnEntryRules(store, WORKSPACE.id, 'In Review', ['checklist_complete', 'ci_green'], USER)
    const card = await createCard(store, {
      workspace: WORKSPACE,
      title: 'Card',
      description: '- [x] a\n- [ ] b',
    }, USER)

    const moved = await place(async session => await session.ops.moveCard(card.id, 'in_review', createPlacementActor()))

    expect(moved.statusId).toBe((await requireColumn(store, WORKSPACE.id, 'in-review')).id)
    expect(moved.unmetRules?.map(item => `${item.rule}: ${item.detail}`)).toEqual([
      'checklist_complete: 1 of 2 unchecked',
      'ci_green: no CI result yet',
    ])
  })

  it('creates a card for a person straight into a ruled column, with the same report', async () => {
    await setColumnEntryRules(store, WORKSPACE.id, 'In Review', ['pull_request_linked'], USER)

    const created = await place(async session => await session.ops.createCard({
      workspace: WORKSPACE,
      title: 'Straight in',
      statusName: 'in_review',
    }, createPlacementActor()))

    expect(created.unmetRules).toHaveLength(1)
    expect(`${created.unmetRules![0]!.rule}: ${created.unmetRules![0]!.detail}`).toBe('pull_request_linked: no pull request linked')
  })

  it('files a person\'s create, update and move as external while the rules only warn (ruling 6-6)', async () => {
    await setColumnEntryRules(store, WORKSPACE.id, 'In Review', ['pull_request_linked'], USER)
    vi.stubEnv('KANBO_ACTOR_ID', 'ada')

    const warned = await place(async (session) => {
      const created = await session.ops.createCard({ workspace: WORKSPACE, title: 'Straight in', statusName: 'in_review' }, createPlacementActor())
      await session.ops.moveCard(created.id, 'backlog', createPlacementActor())
      await session.ops.updateCard(created.id, { title: 'Renamed' }, createPlacementActor())
      const back = await session.ops.moveCard(created.id, 'in_review', createPlacementActor())
      return { created, unmet: [created.unmetRules ?? [], back.unmetRules ?? []] }
    })

    const [created] = await store.issues.listByWorkspace(WORKSPACE.id)
    expect(created).toMatchObject({ id: warned.created.id, createdByKind: 'system', createdById: 'ada' })
    const changes = await store.fieldChanges.listByIssue(created.id)
    expect(changes.length).toBeGreaterThan(0)
    expect(changes.map(change => [change.actorKind, change.actorId])).toEqual(changes.map(() => ['system', 'ada']))
    expect(changes.map(change => change.field)).toEqual(expect.arrayContaining(['title', 'statusId']))
    expect(warned.unmet.flat()).toHaveLength(2)
  })

  it.each(AGENT_SHELL)('refuses a create into a ruled column placed from an agent\'s shell, writing nothing (%s)', async (variable) => {
    await setColumnEntryRules(store, WORKSPACE.id, 'In Review', ['pull_request_linked'], USER)
    const before = await readChangeSeq(store)
    vi.stubEnv(variable, variable === 'KANBO_ACTOR_KIND' ? 'agent' : 'session-1')

    const failure = await place(async session => await session.ops.createCard({
      workspace: WORKSPACE,
      title: 'Straight in',
      statusName: 'in_review',
    }, createPlacementActor())).then(() => undefined, (error: unknown) => error)

    expect(describeFailure(failure).message).toContain('board_column_rules_unmet')
    expect(await readChangeSeq(store)).toBe(before)
  })

  it('warns nothing when the column asks for nothing the card lacks', async () => {
    const card = await createCard(store, { workspace: WORKSPACE, title: 'Card' }, USER)

    const moved = await place(async session => await session.ops.moveCard(card.id, 'in_review', createPlacementActor()))

    expect(moved.unmetRules).toBeUndefined()
  })
})

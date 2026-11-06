import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BoardStore } from '../board-store'
import { readFlowRules } from '../domain/flow-rules'
import type { BoardWorkspaceIdentity } from '../domain/numbering'
import { createCard } from '../ops/cards'
import { readChangeSeq } from '../ops/change-seq'
import { ensureDefaultColumns, requireColumn } from '../ops/columns'
import type { BoardActor } from '../ops/types'
import { createSqliteBoardStore } from '../sqlite/board-store.sqlite'
import type { TestBoardDatabase } from '../testing/board-database'
import { createTestBoardDatabase, seedHostWorkspace } from '../testing/board-database'
import { createPlacementActor, describeColumnRulesRefusal } from './actor'
import { openBoardSession } from './command'
import { registerColumnsCommands } from './commands/columns'
import { describeFailure } from './failure'

const WORKSPACE: BoardWorkspaceIdentity = { id: 'workspace', identifier: 'WOR', name: 'Workspace' }
const USER: BoardActor = { kind: 'user', id: '__self__' }

describe('column flow rules from a terminal', () => {
  let board: TestBoardDatabase
  let store: BoardStore
  let printed: string[]
  let warned: string[]

  beforeEach(async () => {
    board = await createTestBoardDatabase()
    seedHostWorkspace(board, WORKSPACE.id, WORKSPACE.identifier)
    store = createSqliteBoardStore({ database: () => board.database })
    await ensureDefaultColumns(store, WORKSPACE.id)
    for (const name of ['KANBO_ACTOR_KIND', 'KANBO_DB_PATH', 'KANBO_WORKSPACE_ID']) {
      vi.stubEnv(name, undefined)
    }
    printed = []
    warned = []
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
    vi.spyOn(console, 'error').mockImplementation((line: string) => {
      warned.push(line)
    })
    const program = new Command().exitOverride()
    registerColumnsCommands(program)
    await program.parseAsync([...argv, '--db', board.path, '--workspace', WORKSPACE.id], { from: 'user' })
  }

  it('sets where a column accepts cards from and how many it holds, lists them, and opens them again', async () => {
    const [toDo, inProgress] = [await requireColumn(store, WORKSPACE.id, 'to_do'), await requireColumn(store, WORKSPACE.id, 'in_progress')]

    await run(['columns', 'flow', 'in_review', '--from', 'in_progress, to_do', '--wip', '3'])

    expect(readFlowRules(await requireColumn(store, WORKSPACE.id, 'in_review'))).toEqual({ allowedFrom: [toDo.id, inProgress.id], wipLimit: 3 })
    expect(printed.join('\n')).toContain('in_review    In Review — Work done; being checked, or waiting for a person [from: to_do, in_progress] [wip: 3]')
    expect(printed.join('\n')).toContain('done         Done — Finished and accepted [from: in_review]')

    await run(['columns', 'flow', 'in_review', '--wip', 'none'])
    expect(readFlowRules(await requireColumn(store, WORKSPACE.id, 'in_review'))).toEqual({ allowedFrom: [toDo.id, inProgress.id], wipLimit: null })
    await run(['columns', 'flow', 'in_review', '--from', 'any'])
    expect(readFlowRules(await requireColumn(store, WORKSPACE.id, 'in_review'))).toEqual({ allowedFrom: null, wipLimit: null })
  })

  it('refuses setting flow rules in a shell started for an agent, and writes nothing', async () => {
    const before = await readChangeSeq(store)
    vi.stubEnv('KANBO_ACTOR_KIND', 'agent')

    await expect(run(['columns', 'flow', 'done', '--from', 'any'])).rejects.toThrowError(expect.objectContaining({
      exitCode: 4,
      message: describeColumnRulesRefusal('KANBO_ACTOR_KIND=agent', ['columns', 'flow', 'done', '--from', 'any', '--db', board.path, '--workspace', WORKSPACE.id]),
    }))
    expect(await readChangeSeq(store)).toBe(before)
  })

  it('wants --from or --wip, a whole number of 1 or more, and columns of this board', async () => {
    await expect(run(['columns', 'flow', 'in_review'])).rejects.toThrowError(expect.objectContaining({ exitCode: 1, message: 'Pass --from <columns|any>, --wip <count|none>, or both.' }))
    for (const wip of ['0', '2.5', 'many']) {
      await expect(run(['columns', 'flow', 'in_review', '--wip', wip])).rejects.toThrowError(expect.objectContaining({ exitCode: 1, message: '--wip takes a whole number of cards, 1 or more, or none.' }))
    }
    const unknown = await run(['columns', 'flow', 'in_review', '--from', 'nope']).then(() => undefined, (error: unknown) => error)
    expect(describeFailure(unknown).message).toContain('issue_status_not_found')
    const itself = await run(['columns', 'flow', 'in_review', '--from', 'in_review']).then(() => undefined, (error: unknown) => error)
    expect(describeFailure(itself).message).toContain('board_flow_rule_invalid')
    expect(readFlowRules(await requireColumn(store, WORKSPACE.id, 'in_review'))).toEqual({ allowedFrom: null, wipLimit: null })
  })

  it('refuses an agent\'s move the flow rules do not allow with one line per rule, and reports to a person whose move it is', async () => {
    const card = await createCard(store, { workspace: WORKSPACE, title: 'Card', statusName: 'In Progress' }, USER)
    const move = async () => {
      const session = await openBoardSession({ db: board.path, workspace: WORKSPACE.id }, 'write')
      try {
        return await session.ops.moveCard(card.id, 'done', createPlacementActor())
      }
      finally {
        await session.close()
      }
    }

    vi.stubEnv('KANBO_ACTOR_KIND', 'agent')
    const failure = await move().then(() => undefined, (error: unknown) => error)
    expect(describeFailure(failure).message).toContain(`${card.id} can't go into "Done" yet:\n- allowed_from: Done accepts cards from In Review only`)

    vi.stubEnv('KANBO_ACTOR_KIND', undefined)
    const moved = await move()
    expect(moved.unmetRules?.map(item => `${item.rule}: ${item.detail}`)).toEqual(['allowed_from: Done accepts cards from In Review only'])
  })
})

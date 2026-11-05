import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BoardStore } from '../board-store'
import type { BoardWorkspaceIdentity } from '../domain/numbering'
import { createCard } from '../ops/cards'
import type { BoardActor } from '../ops/types'
import { createSqliteBoardStore } from '../sqlite/board-store.sqlite'
import type { TestBoardDatabase } from '../testing/board-database'
import { createTestBoardDatabase, seedHostWorkspace } from '../testing/board-database'
import { registerClaimCommand } from './commands/claim'
import { describeFailure } from './failure'

const WORKSPACE: BoardWorkspaceIdentity = { id: 'workspace', identifier: 'WOR', name: 'Workspace' }
const USER: BoardActor = { kind: 'user', id: '__self__' }

describe('kanbo claim', () => {
  let board: TestBoardDatabase
  let store: BoardStore
  let printed: string[]

  beforeEach(async () => {
    board = await createTestBoardDatabase()
    seedHostWorkspace(board, WORKSPACE.id, WORKSPACE.identifier)
    store = createSqliteBoardStore({ database: () => board.database })
    for (const name of ['KANBO_ACTOR_KIND', 'KANBO_ACTOR_ID', 'KANBO_DB_PATH', 'KANBO_WORKSPACE_ID']) {
      vi.stubEnv(name, undefined)
    }
    printed = []
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    board.dispose()
  })

  async function run(argv: string[]): Promise<string> {
    printed = []
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      printed.push(line)
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const program = new Command().exitOverride()
    registerClaimCommand(program)
    await program.parseAsync([...argv, '--db', board.path, '--workspace', WORKSPACE.id], { from: 'user' })
    return printed.join('\n')
  }

  async function cardInToDo(title: string) {
    return await createCard(store, { workspace: WORKSPACE, title, statusName: 'To Do' }, USER)
  }

  it('takes the first ready card: starts the run, moves the card into In Progress, and prints how to finish', async () => {
    const first = await cardInToDo('First')
    await cardInToDo('Second')

    const said = await run(['claim', '--agent', 'claude'])

    const [started] = await store.runs.listRunning(first.id)
    expect(started).toMatchObject({ agentName: 'claude', launchedByKind: 'external' })
    expect(said).toBe(`Claimed ${first.id}: run ${started!.id} started, card moved to In Progress\nWhen you are done: kanbo run finish ${started!.id} --state finished`)
  })

  it('claims the named card, prints the claim as JSON, and names the run after this shell when --agent is left out', async () => {
    await cardInToDo('First')
    const second = await cardInToDo('Second')
    vi.stubEnv('KANBO_ACTOR_ID', 'codex')

    const claimed = JSON.parse(await run(['claim', 'WOR-2', '--json']))

    expect(claimed).toMatchObject({
      card: { id: second.id, columnSlug: 'in_progress' },
      run: { agentName: 'codex', state: 'running', attempt: 1 },
      column: { slug: 'in_progress' },
    })
  })

  it('says why a named card cannot be taken, and when nothing is ready, exit 1', async () => {
    const only = await cardInToDo('Only')
    await run(['claim', '--agent', 'claude'])

    const taken = await run(['claim', only.id]).then(() => undefined, (error: unknown) => error)
    expect(describeFailure(taken)).toMatchObject({ exitCode: 1, message: `${only.id} is taken: it has a run going.\n  Next: kanbo ready  [board_card_not_ready]` })
    const none = await run(['claim']).then(() => undefined, (error: unknown) => error)
    expect(describeFailure(none).message).toContain('No card in To Do is ready to take')
  })
})

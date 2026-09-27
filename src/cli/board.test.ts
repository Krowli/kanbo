import { join } from 'node:path'

import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BoardStore } from '../board-store'
import type { BoardWorkspaceIdentity } from '../domain/numbering'
import { createBoardOps } from '../ops'
import { ensureDefaultColumns } from '../ops/columns'
import type { BoardActor } from '../ops/types'
import { createSqliteBoardStore } from '../sqlite/board-store.sqlite'
import type { TestBoardDatabase } from '../testing/board-database'
import { createTestBoardDatabase, seedHostWorkspace } from '../testing/board-database'
import { registerBoardCommand } from './commands/board'
import { describeFailure } from './failure'

const WORKSPACE: BoardWorkspaceIdentity = { id: 'workspace', identifier: 'WOR', name: 'Workspace' }
const USER: BoardActor = { kind: 'user', id: '__self__' }
const AGENT: BoardActor = { kind: 'agent', id: 'claude' }

/**
 * `kanbo board`: the board as stacked sections, cut to the terminal's width —
 * kept as golden text in `src/cli/__golden__/board-*.txt` — and the same
 * sections as JSON.
 */
describe('kanbo board', () => {
  let board: TestBoardDatabase
  let store: BoardStore
  let printed: string[]
  const columnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'columns')

  beforeEach(async () => {
    board = await createTestBoardDatabase()
    seedHostWorkspace(board, WORKSPACE.id, WORKSPACE.identifier)
    store = createSqliteBoardStore({ database: () => board.database })
    await ensureDefaultColumns(store, WORKSPACE.id)
    for (const name of ['KANBO_ACTOR_KIND', 'KANBO_DB_PATH', 'KANBO_WORKSPACE_ID', 'NO_COLOR', 'FORCE_COLOR']) {
      vi.stubEnv(name, undefined)
    }
    printed = []
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
      printed.push(values.map(String).join(' '))
    })
    await fillBoard()
  })

  afterEach(() => {
    if (columnsDescriptor) {
      Object.defineProperty(process.stdout, 'columns', columnsDescriptor)
    }
    else {
      delete (process.stdout as { columns?: number }).columns
    }
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    board.dispose()
  })

  /** A board with a bit of everything: a queue, a card being worked on, one waiting, a long Done. */
  async function fillBoard(): Promise<void> {
    const ops = createBoardOps(store)
    const create = async (title: string, column: string): Promise<string> =>
      (await ops.createCard({ workspace: WORKSPACE, title, statusName: column }, USER)).id

    await create('Write the README', 'To Do')
    const working = await create('Add a dark theme that follows the system setting, with a toggle in Settings for people who want to choose', 'In Progress')
    await ops.startRun(working, { agentName: 'claude' }, AGENT)
    await ops.setStatusLine(working, 'writing the toggle; the colours are done, the Settings page is next and then the tests', AGENT)
    const waiting = await create('Fix the login form', 'In Review')
    await ops.waitApproval(waiting, { statusLine: 'login fixed, please check' }, AGENT)
    for (let index = 1; index <= 7; index++) {
      const done = await create(`Finished task ${index}`, 'Done')
      // Changed in order, so "the last five" is tasks 3 to 7.
      await store.issues.update(done, { updatedAt: 1_000 + index })
    }
  }

  function atWidth(columns: number): void {
    Object.defineProperty(process.stdout, 'columns', { value: columns, configurable: true, writable: true })
  }

  async function kanbo(...args: string[]): Promise<unknown> {
    const program = new Command().exitOverride()
    registerBoardCommand(program)
    return await program
      .parseAsync([...args, '--db', board.path, '--workspace', WORKSPACE.id], { from: 'user' })
      .then(() => null, (error: unknown) => error)
  }

  const output = (): string => `${printed.join('\n')}\n`
  const golden = (name: string): string => join(__dirname, '__golden__', `board-${name}.txt`)

  it.each([80, 120])('draws the board at %i columns, every line inside the width', async (width) => {
    atWidth(width)

    expect(await kanbo('board')).toBeNull()

    await expect(output()).toMatchFileSnapshot(golden(String(width)))
    for (const line of output().split('\n')) {
      expect(line.length).toBeLessThan(width)
    }
  })

  it('shows every Done card with --all', async () => {
    atWidth(80)

    expect(await kanbo('board', '--all')).toBeNull()

    await expect(output()).toMatchFileSnapshot(golden('all'))
    expect(output()).not.toContain('more — kanbo board --all')
  })

  it('marks what waits for a person, and says so for a person in an agent\'s shell', async () => {
    expect(await kanbo('board')).toBeNull()
    expect(output()).toContain('Fix the login form  [waiting for you]')
    expect(output()).toContain('[running: claude]')

    printed = []
    vi.stubEnv('KANBO_ACTOR_KIND', 'agent')
    expect(await kanbo('board')).toBeNull()
    expect(output()).toContain('Fix the login form  [waiting for a person]')
  })

  it('prints the same sections as JSON with --json, and only the fields named with --json a,b', async () => {
    expect(await kanbo('board', '--json')).toBeNull()
    const sections = JSON.parse(printed.join('\n')) as { name: string, count: number, cards: { id: string, waitingFor: string | null }[] }[]

    expect(sections.map(section => section.name)).toEqual(['Backlog', 'To Do', 'In Progress', 'In Review', 'Done'])
    const done = sections.find(section => section.name === 'Done')!
    expect(done.count).toBe(7)
    expect(done.cards.map(card => card.id)).toEqual(['WOR-006', 'WOR-007', 'WOR-008', 'WOR-009', 'WOR-010'])
    expect(sections.find(section => section.name === 'In Review')!.cards[0]).toMatchObject({ id: 'WOR-003', waitingFor: 'human' })

    printed = []
    expect(await kanbo('board', '--json', 'name,count')).toBeNull()
    expect(JSON.parse(printed.join('\n'))[4]).toEqual({ name: 'Done', count: 7 })
  })

  it('colours a terminal\'s board only when NO_COLOR does not say otherwise', async () => {
    vi.stubEnv('FORCE_COLOR', '1')
    expect(await kanbo('board')).toBeNull()
    expect(output()).toContain('\u001B[')

    printed = []
    vi.stubEnv('NO_COLOR', '1')
    expect(await kanbo('board')).toBeNull()
    expect(output()).not.toContain('\u001B[')
  })

  it('shows one column with --column, Canceled included when it is empty', async () => {
    expect(await kanbo('board', '--column', 'in-review')).toBeNull()
    expect(printed.join('\n').split('\n')[0]).toBe('In Review (1)')
    expect(output()).not.toContain('To Do')

    printed = []
    expect(await kanbo('board', '--column', 'canceled')).toBeNull()
    expect(output()).toBe('Canceled (0)\n  no cards\n')

    const outcome = await kanbo('board', '--column', 'nowhere')
    expect(describeFailure(outcome).message).toBe('This board has no column "nowhere". See kanbo columns list.')
  })

  it('shows Canceled once it holds a card', async () => {
    await createBoardOps(store).createCard({ workspace: WORKSPACE, title: 'Dropped idea', statusName: 'Canceled' }, USER)

    expect(await kanbo('board')).toBeNull()

    expect(output()).toContain('Canceled (1)\n  WOR-011  Dropped idea')
  })
})

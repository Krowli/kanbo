import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Command } from 'commander'
import { sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BoardStore } from '../board-store'
import type { BoardWorkspaceIdentity } from '../domain/numbering'
import { createCard, waitApproval } from '../ops/cards'
import { readChangeSeq } from '../ops/change-seq'
import { startRun } from '../ops/runs'
import type { BoardActor } from '../ops/types'
import { createSqliteBoardStore } from '../sqlite/board-store.sqlite'
import type { TestBoardDatabase } from '../testing/board-database'
import { createTestBoardDatabase, seedHostWorkspace } from '../testing/board-database'
import { createKanboMcpServer } from '../mcp/server'
import { METRICS_HISTORY, METRICS_NOW, writeMetricsHistory } from '../testing/fixtures/board-metrics'
import { writeBinding } from './binding'
import { parseCalendarDay } from './command'
import { registerApproveCommand } from './commands/approve'
import { registerBoardCommand } from './commands/board'
import { registerSprintCommands } from './commands/sprint'
import { defaultStatsFrom, registerStatsCommand } from './commands/stats'
import { openMcpBoard } from './mcp-board'
import { describeFailure } from './failure'

const WORKSPACE: BoardWorkspaceIdentity = { id: 'workspace', identifier: 'WOR', name: 'Workspace' }
const USER: BoardActor = { kind: 'user', id: '__self__' }

describe('board commands', () => {
  let board: TestBoardDatabase
  let store: BoardStore

  beforeEach(async () => {
    board = await createTestBoardDatabase()
    seedHostWorkspace(board, WORKSPACE.id, WORKSPACE.identifier)
    store = createSqliteBoardStore({ database: () => board.database })
    for (const name of ['KANBO_DB_PATH', 'KANBO_WORKSPACE_ID']) {
      vi.stubEnv(name, undefined)
    }
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    board.dispose()
  })

  async function createCardIn(title: string, statusName: string) {
    return await createCard(store, { workspace: WORKSPACE, title, statusName }, USER)
  }

  async function run(argv: string[]): Promise<string> {
    return await runUnscoped([...argv, '--workspace', WORKSPACE.id])
  }

  /** The same, without naming a workspace — for the tests about how one is resolved. */
  async function runUnscoped(argv: string[]): Promise<string> {
    const printed: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      printed.push(String(line))
    })
    const program = new Command().exitOverride()
    registerBoardCommand(program)
    registerApproveCommand(program)
    registerSprintCommands(program)
    registerStatsCommand(program)
    await program.parseAsync([...argv, '--db', board.path], { from: 'user' })
    return printed.join('\n')
  }

  it('names a card written as a description alone by that description, on the board', async () => {
    const card = await createCard(store, { workspace: WORKSPACE, statusName: 'To Do', description: '## Fix the race\nmore' }, USER)
    expect(card.title).toBe(card.id)

    expect(await run(['board'])).toMatch(new RegExp(`^\\s+${card.id}\\s+Fix the race$`, 'm'))
    expect(JSON.stringify(JSON.parse(await run(['board', '--json'])))).toContain(`"title":"${card.id}"`)
  })

  it('warns on stderr about a field it does not have, and still prints the ones it does', async () => {
    await createCardIn('Card', 'To Do')
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      errors.push(String(line))
    })

    const printed = await run(['board', '--json', 'name,nope'])

    expect((JSON.parse(printed) as Record<string, unknown>[]).every(section => Object.keys(section).join() === 'name')).toBe(true)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('unknown field "nope"')
    expect(errors[0]).toContain('name')
  })

  it('creates sprints from calendar days and lists them with the current one marked', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const created = JSON.parse(await run(['sprint', 'create', '--title', 'Now', '--start', today, '--due', today, '--format', 'json']))
    expect(created).toMatchObject({ title: 'Now', status: 'open', current: true, openCards: 0, doneCards: 0 })
    expect(created.dueDate - created.startDate).toBe(86_399)
    await run(['sprint', 'create', '--title', 'Later', '--start', '2999-01-01', '--due', '2999-01-14'])
    await createCard(store, { workspace: WORKSPACE, title: 'Card', milestoneId: created.id }, USER)

    expect(JSON.parse(await run(['sprint', 'list', '--json', 'title,current,openCards'])))
      .toEqual([{ title: 'Now', current: true, openCards: 1 }, { title: 'Later', current: false, openCards: 0 }])
    const text = await run(['sprint', 'list'])
    expect(text.split('\n')[0]).toMatch(/^\* .*Now/)

    await expect(run(['sprint', 'create', '--title', 'Bad', '--start', 'tomorrow', '--due', today])).rejects.toThrow()
    await expect(run(['sprint', 'create', '--title', 'Backwards', '--start', '2999-01-14', '--due', '2999-01-01'])).rejects.toThrow()
  })

  it('never touches a card from another workspace, whatever its key looks like', async () => {
    for (const name of ['KANBO_ACTOR_KIND', 'CLAUDECODE', 'GEMINI_CLI', 'CURSOR_AGENT', 'CODEX_THREAD_ID']) {
      vi.stubEnv(name, undefined)
    }
    const mine = await createCardIn('Mine', 'In Review')
    seedHostWorkspace(board, 'other-workspace', 'OTH')
    const theirs = await createCard(store, {
      workspace: { id: 'other-workspace', identifier: 'OTH', name: 'Other' },
      title: 'Theirs',
      statusName: 'In Review',
    }, USER)
    await waitApproval(store, theirs.id, { statusLine: 'waiting' }, { kind: 'agent', id: 'agent-1' })
    const before = await readChangeSeq(store)

    // The two cards carry the same number in their own workspaces, so a key read
    // for its digits alone would act on this board's card on the other's say-so.
    expect(theirs.number).toBe(mine.number)
    const refusal = expect.objectContaining({ exitCode: 2, message: expect.stringContaining(`No card "${theirs.id}" on this board.`) })
    await expect(run(['approve', theirs.id])).rejects.toThrowError(refusal)

    expect((await store.issues.findById(theirs.id))?.waitingFor).toBe('human')
    expect((await store.issues.findById(mine.id))?.statusId).toBe(mine.statusId)
    expect(await readChangeSeq(store)).toBe(before)
  })

  it('never ends a run that belongs to another workspace', async () => {
    seedHostWorkspace(board, 'other-workspace', 'OTH')
    const theirs = await createCard(store, {
      workspace: { id: 'other-workspace', identifier: 'OTH', name: 'Other' },
      title: 'Theirs',
      statusName: 'To Do',
    }, USER)
    const theirRun = await startRun(store, theirs.id, { agentName: 'Claude' }, USER)
    const before = await readChangeSeq(store)

    // A run id carries no key to read a workspace off, so the card behind it is
    // what says whether this board owns the run at all. An agent reaches it through the MCP tool.
    vi.stubEnv('KANBO_DB_PATH', board.path)
    vi.stubEnv('KANBO_WORKSPACE_ID', WORKSPACE.id)
    const mcpBoard = await openMcpBoard({ actor: { kind: 'external', id: 'tester' } })
    const server = createKanboMcpServer(mcpBoard, { includeRunTools: true })
    const [clientChannel, serverChannel] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'run-test', version: '0.0.0' })
    await Promise.all([client.connect(clientChannel), server.connect(serverChannel)])
    try {
      const result = await client.callTool({ name: 'kanbo_run_finish', arguments: { run: theirRun.id, state: 'finished' } })
      expect(result.isError).toBe(true)
      expect((result.content as { text: string }[]).map(part => part.text).join('\n')).toContain(`No run "${theirRun.id}" on this board.`)
    }
    finally {
      await client.close()
      await mcpBoard.close()
    }

    expect((await store.runs.findById(theirRun.id))?.state).toBe('running')
    expect(await readChangeSeq(store)).toBe(before)
  })

  describe('which workspace the command is about', () => {
    /** The project as a host app recorded it — on macOS a temp path is a symlink into `/private`. */
    let recordedDir: string
    /** The same folder as the shell sees it, with the symlink resolved. */
    let projectDir: string
    let elsewhere: string

    beforeEach(() => {
      recordedDir = mkdtempSync(join(tmpdir(), 'kanbo-project-'))
      projectDir = realpathSync(recordedDir)
      elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'kanbo-elsewhere-')))
      vi.spyOn(process, 'cwd').mockReturnValue(join(projectDir, 'packages', 'web'))
    })

    afterEach(() => {
      rmSync(projectDir, { force: true, recursive: true })
      rmSync(elsewhere, { force: true, recursive: true })
    })

    function registerWorkspace(id: string, name: string, identifier: string, nodeId: string, path: string): void {
      // Raw SQL, like the adapter under test: `workspaces` is a host app's table
      // and this package has no schema for it (ruling 5-1). The table itself is
      // already there — `seedHostWorkspace` in the outer `beforeEach` stands
      // it up.
      const locatorJson = JSON.stringify({ nodeId, path })
      board.database.run(sql`
        insert or replace into workspaces (id, name, identifier, locator_json)
        values (${id}, ${name}, ${identifier}, ${locatorJson})
      `)
    }

    async function createCardFor(id: string, identifier: string, title: string) {
      return await createCard(store, {
        workspace: { id, identifier, name: title },
        title,
        statusName: 'To Do',
      }, USER)
    }

    it('obeys --workspace, then the environment, then the binding, then the folder it is standing in', async () => {
      registerWorkspace('alpha', 'Alpha', 'ALP', 'local', recordedDir)
      registerWorkspace('beta', 'Beta', 'BET', 'local', elsewhere)
      const inAlpha = await createCardFor('alpha', 'ALP', 'Alpha card')
      const inBeta = await createCardFor('beta', 'BET', 'Beta card')

      // Nothing said which workspace: the folder the command was typed in does.
      expect(await runUnscoped(['board', '--json'])).toContain(inAlpha.id)

      // A binding beats the folder — a worktree may sit inside another project.
      writeBinding(projectDir, { schemaVersion: 1, workspaceId: 'beta', boardId: null, dbPath: null })
      expect(await runUnscoped(['board', '--json'])).toContain(inBeta.id)

      // The environment beats the binding.
      vi.stubEnv('KANBO_WORKSPACE_ID', 'alpha')
      expect(await runUnscoped(['board', '--json'])).toContain(inAlpha.id)

      // And what the caller typed beats everything, by name as well as by id.
      expect(await runUnscoped(['board', '--workspace', 'Beta', '--json'])).toContain(inBeta.id)
    })

    it('never takes a workspace from another machine, even at the same path', async () => {
      registerWorkspace('ghost', 'Ghost', 'GHO', 'other-node', recordedDir)
      registerWorkspace('alpha', 'Alpha', 'ALP', 'local', recordedDir)
      const inAlpha = await createCardFor('alpha', 'ALP', 'Alpha card')
      await createCardFor('ghost', 'GHO', 'Ghost card')

      expect(await runUnscoped(['board', '--json'])).toContain(inAlpha.id)
    })

    it('refuses a name two workspaces share instead of picking one', async () => {
      registerWorkspace('alpha', 'Shared', 'ALP', 'local', recordedDir)
      registerWorkspace('beta', 'Shared', 'BET', 'local', elsewhere)

      const refusal = expect.objectContaining({ exitCode: 2, message: expect.stringContaining('alpha, beta') })
      await expect(runUnscoped(['board', '--workspace', 'Shared'])).rejects.toThrowError(refusal)
    })
  })

  describe('kanbo stats', () => {
    beforeEach(async () => {
      await writeMetricsHistory(store, METRICS_HISTORY)
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(METRICS_NOW * 1000)
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('prints how work flowed over a range, cut at now', async () => {
      const text = await run(['stats', '--from', '2025-12-29', '--to', '2026-01-25'])

      expect(text.split('\n')).toEqual([
        '2025-12-29 → 2026-01-22',
        'Cycle time      p50 2.6d · p85 7d (5 cards)',
        'Lead time       p50 3.6d · p85 8d',
        'Throughput      2026-W01 1 · 2026-W02 2 · 2026-W03 2 · 2026-W04 0',
        'In progress     In Progress 1/2 · In Review 1',
        'First pass      40% · attempts 1.4 per card',
        'Returns         3 (people 1 · agents 1 · outside 1) · 0.6 per card',
        'Canceled        1',
        'Aging           WOR-005 In Progress 20.1d (older than p85)',
        '                WOR-006 In Review 3.1d',
        'Time in column  To Do 4.2d · In Progress 11.7d · In Review 6.5d · Done 1d',
        'Agents          claude: 6 runs (5 finished · 0 failed · 0 stopped · 1 running) · median 1d · 4 cards finished · 75% returned',
        '                codex: 3 runs (2 finished · 1 failed · 0 stopped · 0 running) · median 1d · 1 card finished · 100% returned',
        '                gemini: 1 run (0 finished · 0 failed · 1 stopped · 0 running) · median 1h · 0 cards finished · — returned',
        'People          __self__: 6 created · 2 approved · 1 returned · 8 moved',
        '                alice: 0 created · 1 approved · 0 returned · 0 moved',
        'Cumulative flow by day: kanbo stats --json cumulativeFlow',
      ])
    })

    it('reads the last 12 ISO weeks when no range is given', async () => {
      // Now is in 2026-W04, which starts on 2026-01-19; eleven weeks before is 2025-11-03.
      expect((await run(['stats'])).split('\n')[0]).toBe('2025-11-03 → 2026-01-22')
    })

    it('reads a sprint over its own dates, with planned against done', async () => {
      const lines = (await run(['stats', '--sprint', 'sprint-1'])).split('\n')

      expect(lines.slice(0, 3)).toEqual([
        '2025-12-29 → 2026-01-11',
        'Sprint 1: 3 planned · 3 done',
        'Cycle time      p50 2d · p85 6d (2 cards)',
      ])
    })

    it('prints the fields --json names, from the same numbers', async () => {
      const printed = JSON.parse(await run(['stats', '--from', '2025-12-29', '--json', 'cycleTime,canceled']))

      expect(printed).toEqual({ cycleTime: { cards: 5, p50: 226_799, p85: 604_800 }, canceled: 1 })
    })

    it('says nothing is measured yet when the range starts after now', async () => {
      const text = await run(['stats', '--from', '2026-02-01', '--to', '2026-02-10'])

      expect(text.split('\n')).toEqual(['2026-02-01 → 2026-01-22', 'Nothing measured yet: the range starts after now.'])
    })

    it('says a sprint the board has not got, and a range that runs backwards', async () => {
      vi.stubEnv('KANBO_DEBUG', '')
      const missing = await run(['stats', '--sprint', 'nope']).then(() => undefined, (error: unknown) => error)
      expect(describeFailure(missing).message).toContain('No sprint "nope" on this board.')

      const backwards = await run(['stats', '--from', '2026-01-10', '--to', '2026-01-01']).then(() => undefined, (error: unknown) => error)
      expect(describeFailure(backwards).message).toContain('The range starts after it ends')
    })
  })
  describe('dates on the command line', () => {
    it('refuses a day the calendar does not have, and a day that is not padded', () => {
      for (const value of ['2026-02-30', '2026-04-31', '2026-4-1']) {
        expect(() => parseCalendarDay(value, false), value).toThrow('Expected a date as YYYY-MM-DD or unix seconds')
      }
    })

    it('runs an end day through 23:59:59 UTC, and takes unix seconds as they are', () => {
      expect(parseCalendarDay('2026-02-28', true)).toBe(Date.parse('2026-02-28T23:59:59Z') / 1000)
      expect(parseCalendarDay('2026-02-28', false)).toBe(Date.parse('2026-02-28T00:00:00Z') / 1000)
      expect(parseCalendarDay('1767225600', true)).toBe(1_767_225_600)
    })

    it('starts the default range 11 Mondays before this one, on either edge of the week', () => {
      for (const now of ['2026-01-19T00:00:00Z', '2026-01-25T23:59:59Z']) {
        expect(defaultStatsFrom(Date.parse(now) / 1000), now).toBe(Date.parse('2025-11-03T00:00:00Z') / 1000)
      }
    })
  })
})

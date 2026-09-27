import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Command } from 'commander'
import { sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BoardStore } from '../board-store'
import type { BoardWorkspaceIdentity } from '../domain/numbering'
import { normalizeStatusName } from '../domain/status-name'
import { createCard } from '../ops/cards'
import { readChangeSeq } from '../ops/change-seq'
import { finishRun, startRun } from '../ops/runs'
import type { BoardActor } from '../ops/types'
import { createSqliteBoardStore } from '../sqlite/board-store.sqlite'
import type { TestBoardDatabase } from '../testing/board-database'
import { createTestBoardDatabase, seedHostWorkspace } from '../testing/board-database'
import { writeBinding } from './binding'
import { registerCardCommands } from './commands/card'
import { registerReadyCommand } from './commands/ready'
import { registerRunCommands } from './commands/run'
import { registerSprintCommands } from './commands/sprint'
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
    registerCardCommands(program)
    registerReadyCommand(program)
    registerRunCommands(program)
    registerSprintCommands(program)
    await program.parseAsync([...argv, '--db', board.path], { from: 'user' })
    return printed.join('\n')
  }

  it('moves a card to the column it names, and tells every reader the board changed', async () => {
    const card = await createCardIn('Card', 'To Do')
    const before = await readChangeSeq(store)

    await run(['card', 'move', card.id, 'in_progress'])

    const moved = await store.issues.findById(card.id)
    const column = (await store.statuses.listByWorkspace(WORKSPACE.id))
      .find(candidate => candidate.id === moved?.statusId)
    expect(normalizeStatusName(column?.name ?? '')).toBe('in_progress')
    expect(await readChangeSeq(store)).toBe(before + 1)
  })

  it('says a column the board has not got in plain words, with what to run next', async () => {
    vi.stubEnv('KANBO_DEBUG', '')
    const card = await createCardIn('Card', 'To Do')

    const outcome = await run(['card', 'move', card.id, 'foo']).then(() => undefined, (error: unknown) => error)

    expect(describeFailure(outcome)).toEqual({
      exitCode: 1,
      code: 'issue_status_not_found',
      message: 'No column "foo" on this board.\n  Next: kanbo columns list  [issue_status_not_found]',
    })
  })

  it('says a card the board has not got, with what to run next', async () => {
    const outcome = await run(['card', 'move', '999', 'done']).then(() => undefined, (error: unknown) => error)

    expect(describeFailure(outcome)).toEqual({ exitCode: 2, message: 'No card "999" on this board.\n  Next: kanbo card list' })
  })

  it('offers a card nobody is working on, and stops offering it once a run starts', async () => {
    const ready = await createCardIn('Ready', 'To Do')
    const launched = await createCardIn('Launched', 'To Do')

    expect(await run(['ready'])).toContain('Launched')

    await startRun(store, launched.id, { agentName: 'Claude' }, USER)

    const offered = await run(['ready'])
    expect(offered).toContain(ready.id)
    expect(offered).not.toContain(launched.id)
  })

  it('prints only the fields --json names', async () => {
    await createCardIn('Card', 'To Do')

    const printed = await run(['card', 'list', '--json', 'title,column'])

    expect(JSON.parse(printed)).toEqual([{ title: 'Card', column: 'To Do' }])
  })

  it('names a card written as a description alone by that description, in every listing and on its own', async () => {
    const card = await createCard(store, { workspace: WORKSPACE, statusName: 'To Do', description: '## Fix the race\nmore' }, USER)
    expect(card.title).toBe(card.id)

    for (const printed of [await run(['card', 'list']), await run(['ready'])]) {
      expect(printed).toMatch(new RegExp(`^${card.id}\\s+To Do\\s+Fix the race$`))
    }
    expect((await run(['card', 'get', card.id])).split('\n')[1]).toBe('Fix the race')
    expect(JSON.parse(await run(['card', 'list', '--json', 'title']))).toEqual([{ title: card.id }])
  })

  it('warns on stderr about a field it does not have, and still prints the ones it does', async () => {
    const card = await createCardIn('Card', 'To Do')
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      errors.push(String(line))
    })

    const printed = await run(['card', 'get', card.id, '--json', 'id,nope'])

    expect(JSON.parse(printed)).toEqual({ id: card.id })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('unknown field "nope"')
    expect(errors[0]).toContain('id')
  })

  it('counts a card\'s attempts and names the run going on right now', async () => {
    const card = await createCardIn('Card', 'To Do')
    const started = await startRun(store, card.id, { agentName: 'Claude' }, USER)

    const printed = await run(['card', 'list', '--json', 'id,attemptCount,activeRun'])

    expect(JSON.parse(printed)).toEqual([{
      id: card.id,
      attemptCount: 1,
      activeRun: {
        id: started.id,
        agentName: 'Claude',
        state: 'running',
        startedAt: started.startedAt,
      },
    }])
  })

  it('counts which attempt a run is, starting from the card\'s first launch', async () => {
    const card = await createCardIn('Card', 'To Do')

    const first = await run(['run', 'start', card.id, '--agent', 'Claude', '--json', 'attempt'])
    expect(JSON.parse(first)).toEqual({ attempt: 1 })

    const second = await run(['run', 'start', card.id, '--agent', 'Claude', '--json', 'attempt'])
    expect(JSON.parse(second)).toEqual({ attempt: 2 })
  })

  it('still prints only the field a caller asks for once a run finishes', async () => {
    const card = await createCardIn('Card', 'To Do')
    const started = await startRun(store, card.id, { agentName: 'Claude' }, USER)

    const printed = await run(['run', 'finish', started.id, '--state', 'finished', '--json', 'state'])

    expect(JSON.parse(printed)).toEqual({ state: 'finished' })
  })

  it('takes the session an agent names at launch, and refuses one it cannot parse back', async () => {
    const card = await createCardIn('Card', 'To Do')

    const started = await run(['run', 'start', card.id, '--agent', 'Claude', '--session', 'claude:abc-123', '--json', 'externalSessionRef'])
    expect(JSON.parse(started)).toEqual({ externalSessionRef: 'claude:abc-123' })

    await expect(run(['run', 'start', card.id, '--agent', 'Claude', '--session', 'not-a-ref'])).rejects.toThrow()
  })

  it('attaches a session ref to a run, even after it ended, and never replaces one', async () => {
    const card = await createCardIn('Card', 'To Do')
    const started = await startRun(store, card.id, { agentName: 'Claude' }, USER)
    await finishRun(store, started.id, { state: 'finished' }, USER)

    const printed = await run(['run', 'attach-session', started.id, 'codex:session-9', '--json', 'externalSessionRef'])

    expect(JSON.parse(printed)).toEqual({ externalSessionRef: 'codex:session-9' })
    await expect(run(['run', 'attach-session', started.id, 'claude:other'])).rejects.toThrow()
  })

  it('links a pull request once, lists it, and unlinks it by the id it printed', async () => {
    const card = await createCardIn('Card', 'To Do')
    const before = await readChangeSeq(store)

    const added = JSON.parse(await run(['card', 'pr', 'add', card.id, 'https://github.com/octo/repo/pull/7', '--format', 'json']))
    expect(added).toEqual({
      id: expect.any(String),
      issueId: card.id,
      owner: 'octo',
      repo: 'repo',
      number: 7,
      url: 'https://github.com/octo/repo/pull/7',
      createdAt: expect.any(Number),
    })
    expect(await readChangeSeq(store)).toBe(before + 1)
    // Linking it again is not a change, and writes no comment either time.
    expect(JSON.parse(await run(['card', 'pr', 'add', card.id, 'octo/repo#7', '--json', 'id']))).toEqual({ id: added.id })
    expect(await readChangeSeq(store)).toBe(before + 1)
    expect(await store.comments.listByIssue(card.id)).toEqual([])

    expect(JSON.parse(await run(['card', 'pr', 'list', card.id, '--json', 'id,number']))).toEqual([{ id: added.id, number: 7 }])
    expect(await run(['card', 'pr', 'list', card.id])).toContain('octo/repo#7')

    await run(['card', 'pr', 'remove', card.id, added.id])
    expect(await run(['card', 'pr', 'list', card.id])).toBe(`${card.id} names no pull requests.`)

    await expect(run(['card', 'pr', 'add', card.id, 'https://github.com/octo/repo/issues/7'])).rejects.toThrow()
    await expect(run(['card', 'pr', 'remove', card.id, added.id])).rejects.toThrow()
    expect(await store.pullRequests.listByIssue(card.id)).toEqual([])
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

  it('takes a card by its number as readily as by its key', async () => {
    const card = await createCardIn('Card', 'To Do')

    const printed = await run(['card', 'get', `${WORKSPACE.identifier}-${card.number}`, '--json', 'id'])

    expect(JSON.parse(printed)).toEqual({ id: card.id })
    expect(JSON.parse(await run(['card', 'get', String(card.number), '--json', 'id']))).toEqual({ id: card.id })
  })

  it('never touches a card from another workspace, whatever its key looks like', async () => {
    const mine = await createCardIn('Mine', 'To Do')
    seedHostWorkspace(board, 'other-workspace', 'OTH')
    const theirs = await createCard(store, {
      workspace: { id: 'other-workspace', identifier: 'OTH', name: 'Other' },
      title: 'Theirs',
      statusName: 'To Do',
    }, USER)
    const before = await readChangeSeq(store)

    // The two cards carry the same number in their own workspaces, so a key read
    // for its digits alone would move this board's card on the other's say-so.
    expect(theirs.number).toBe(mine.number)
    const refusal = expect.objectContaining({ exitCode: 2, message: `No card "${theirs.id}" on this board.\n  Next: kanbo card list` })
    await expect(run(['card', 'move', theirs.id, 'in_progress'])).rejects.toThrowError(refusal)
    await expect(run(['card', 'get', theirs.id])).rejects.toThrowError(refusal)

    expect((await store.issues.findById(theirs.id))?.statusId).toBe(theirs.statusId)
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
    // what says whether this board owns the run at all.
    await expect(run(['run', 'finish', theirRun.id, '--state', 'finished']))
      .rejects
      .toThrowError(expect.objectContaining({ exitCode: 2, message: `No run "${theirRun.id}" on this board.` }))

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
      expect(await runUnscoped(['card', 'list', '--json', 'id'])).toContain(inAlpha.id)

      // A binding beats the folder — a worktree may sit inside another project.
      writeBinding(projectDir, { schemaVersion: 1, workspaceId: 'beta', boardId: null, dbPath: null })
      expect(await runUnscoped(['card', 'list', '--json', 'id'])).toContain(inBeta.id)

      // The environment beats the binding.
      vi.stubEnv('KANBO_WORKSPACE_ID', 'alpha')
      expect(await runUnscoped(['card', 'list', '--json', 'id'])).toContain(inAlpha.id)

      // And what the caller typed beats everything, by name as well as by id.
      expect(await runUnscoped(['card', 'list', '--workspace', 'Beta', '--json', 'id'])).toContain(inBeta.id)
    })

    it('never takes a workspace from another machine, even at the same path', async () => {
      registerWorkspace('ghost', 'Ghost', 'GHO', 'other-node', recordedDir)
      registerWorkspace('alpha', 'Alpha', 'ALP', 'local', recordedDir)
      const inAlpha = await createCardFor('alpha', 'ALP', 'Alpha card')
      await createCardFor('ghost', 'GHO', 'Ghost card')

      expect(await runUnscoped(['card', 'list', '--json', 'id'])).toContain(inAlpha.id)
    })

    it('refuses a name two workspaces share instead of picking one', async () => {
      registerWorkspace('alpha', 'Shared', 'ALP', 'local', recordedDir)
      registerWorkspace('beta', 'Shared', 'BET', 'local', elsewhere)

      const refusal = expect.objectContaining({ exitCode: 2, message: expect.stringContaining('alpha, beta') })
      await expect(runUnscoped(['card', 'list', '--workspace', 'Shared'])).rejects.toThrowError(refusal)
    })
  })
})

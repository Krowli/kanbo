import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { Command } from 'commander'
import { sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BoardStore } from '../board-store'
import type { BoardWorkspaceIdentity } from '../domain/numbering'
import { createCard, waitApproval } from '../ops/cards'
import { readChangeSeq } from '../ops/change-seq'
import type { BoardActor } from '../ops/types'
import { createSqliteBoardStore } from '../sqlite/board-store.sqlite'
import { migrateBoardFile } from '../sqlite/migrate'
import { assertBoardSchema, markBoardFileOwnedByKanbo, openBoardDatabase } from '../sqlite/open-database'
import type { TestBoardDatabase } from '../testing/board-database'
import { seedHostWorkspace } from '../testing/board-database'
import { APPROVAL_IS_HUMAN_MESSAGE } from './actor'
import { writeBinding } from './binding'
import { registerApproveCommand } from './commands/approve'
import { registerCardCommands } from './commands/card'
import { BOARD_FILE_NOT_MIGRATED_MESSAGE, registerMigrateCommand } from './commands/migrate'
import { registerReadyCommand } from './commands/ready'
import { registerRolesCommands, ROLES_NEED_A_DATABASE_MESSAGE } from './commands/roles'
import { FILE_SCHEMA_OUTDATED_MESSAGE } from './schema-guard'
import { FILE_IDENTIFIER_NOT_RESOLVED_MESSAGE, FILE_WORKSPACE_NOT_RESOLVED_MESSAGE } from './workspace'

/**
 * The command line on a board file of this project's own — everything `kanbo
 * init --file` creates, driven the way every other command drives it.
 *
 * The card flow, `ready` and the person-only refusals are the same code every
 * other board runs through, so this is not a second copy of `commands.test.ts`
 * or `approve.test.ts`: it exists to show that a file this package created and
 * marked itself, rather than a host app, carries the workspace on its binding
 * instead of a `workspaces` table and still comes out the other end the same
 * way. `migrate` and `roles` are the two commands whose *behaviour* differs by
 * file, and are checked here in full.
 */

const WORKSPACE: BoardWorkspaceIdentity = { id: 'workspace', identifier: 'WOR', name: 'WOR' }
const USER: BoardActor = { kind: 'user', id: '__self__' }
const AGENT: BoardActor = { kind: 'agent', id: 'agent-1' }

/** The variable that marks a shell as an agent's. */
const AGENT_SHELL = ['KANBO_ACTOR_KIND']

/** Nothing in the environment may decide which board or workspace these tests are about. */
const BOARD_VARIABLES = ['KANBO_DB_PATH', 'KANBO_DATABASE_URL', 'KANBO_WORKSPACE_ID']

/** A board file this package created and migrated itself — `kanbo init --file`'s own two steps, by hand. */
async function createOwnBoardFile(projectDir: string): Promise<TestBoardDatabase> {
  const path = join(projectDir, '.kanbo', 'board.db')
  mkdirSync(dirname(path), { recursive: true })
  const board = await openBoardDatabase(path)
  migrateBoardFile(board.database)
  markBoardFileOwnedByKanbo(board.database)
  return { ...board, path, dispose: () => board.close() }
}

describe('the command line on a board file of this project\'s own', () => {
  let projectDir: string
  let board: TestBoardDatabase
  let store: BoardStore

  beforeEach(async () => {
    projectDir = mkdtempSync(join(tmpdir(), 'kanbo-file-board-'))
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir)
    for (const name of [...AGENT_SHELL, ...BOARD_VARIABLES]) {
      vi.stubEnv(name, undefined)
    }

    board = await createOwnBoardFile(projectDir)
    store = createSqliteBoardStore({ database: () => board.database })
    writeBinding(projectDir, {
      schemaVersion: 1,
      workspaceId: WORKSPACE.id,
      boardId: null,
      dbPath: join('.kanbo', 'board.db'),
      identifier: WORKSPACE.identifier,
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    board.dispose()
    rmSync(projectDir, { force: true, recursive: true })
  })

  /** The same, with exactly the arguments given — for `roles print`, which takes no board flag at all. */
  async function runExactly(argv: string[]): Promise<string> {
    const printed: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      printed.push(String(line))
    })
    const program = new Command().exitOverride()
    registerCardCommands(program)
    registerReadyCommand(program)
    registerApproveCommand(program)
    registerMigrateCommand(program)
    registerRolesCommands(program)
    await program.parseAsync(argv, { from: 'user' })
    return printed.join('\n')
  }

  /** Every command below resolves the workspace from the binding, the way an own file always does. */
  async function run(argv: string[]): Promise<string> {
    return await runExactly([...argv, '--db', board.path])
  }

  it('follows the workspace id a host app wrote into the binding when it attached the file', async () => {
    // The command line's half of ruling 5-7. `kanbo init --file` numbered
    // these cards under the folder's own slug; attaching the file re-keyed
    // every row to a host app's workspace id and rewrote the binding to say so.
    // Nothing here was told about any of it - the binding is where the answer
    // has always come from - and the same cards have to come back.
    await run(['card', 'create', '--title', 'Made before the app saw it'])

    const hostWorkspaceId = '6f0c2a1e-2f4b-4f5e-9c3a-0d7d1b8e4c21'
    for (const table of ['issue_statuses', 'issue_milestones', 'issues']) {
      board.database.run(sql.raw(
        `update ${table} set workspace_id = '${hostWorkspaceId}' where workspace_id = '${WORKSPACE.id}'`,
      ))
    }
    writeBinding(projectDir, {
      schemaVersion: 1,
      workspaceId: hostWorkspaceId,
      boardId: null,
      dbPath: join('.kanbo', 'board.db'),
      identifier: 'BST',
    })

    const printed = await run(['card', 'list', '--json', 'id,title'])

    expect(JSON.parse(printed)).toEqual([{ id: 'WOR-001', title: 'Made before the app saw it' }])
    // The card keeps the key it was printed under: comments, runs and links all
    // point at it, and a prefix is not worth breaking them for.
    await run(['card', 'move', 'WOR-001', 'in_progress'])
    expect(JSON.parse(await run(['card', 'list', '--json', 'id,columnSlug'])))
      .toEqual([{ id: 'WOR-001', columnSlug: 'in_progress' }])
  })

  it('creates, lists and moves cards under the key the binding gives, with no workspaces table in sight', async () => {
    await run(['card', 'create', '--title', 'First card'])
    const before = await readChangeSeq(store)

    await run(['card', 'move', 'WOR-001', 'in_progress'])

    const printed = await run(['card', 'list', '--json', 'id,title,columnSlug'])
    expect(JSON.parse(printed)).toEqual([{ id: 'WOR-001', title: 'First card', columnSlug: 'in_progress' }])
    expect(await readChangeSeq(store)).toBe(before + 1)
  })

  it('offers a card nobody has started through kanbo ready', async () => {
    const card = await createCard(store, { workspace: WORKSPACE, title: 'Ready card', statusName: 'To Do' }, USER)

    expect(await run(['ready'])).toContain(card.id)
  })

  it('refuses an approval in a shell started for an agent, and leaves the card waiting', async () => {
    const card = await createCard(store, { workspace: WORKSPACE, title: 'Card', statusName: 'In Review' }, AGENT)
    await waitApproval(store, card.id, { statusLine: 'need a person' }, AGENT)
    const before = await readChangeSeq(store)
    vi.stubEnv('KANBO_ACTOR_KIND', 'agent')

    const refusal = expect.objectContaining({ exitCode: 4, message: APPROVAL_IS_HUMAN_MESSAGE })
    await expect(run(['approve', card.id])).rejects.toThrowError(refusal)

    expect((await store.issues.findById(card.id))?.waitingFor).toBe('human')
    expect(await readChangeSeq(store)).toBe(before)
  })

  it('accepts the same approval from a person\'s own terminal', async () => {
    const card = await createCard(store, { workspace: WORKSPACE, title: 'Card', statusName: 'In Review' }, AGENT)
    await waitApproval(store, card.id, { statusLine: 'need a person' }, AGENT)

    await run(['approve', card.id, '--comment', 'looks right'])

    expect((await store.issues.findById(card.id))?.waitingFor).toBeNull()
  })

  it('migrates an own file with the package chain, and says the same thing the second time', async () => {
    const first = await run(['migrate'])
    const second = await run(['migrate'])

    expect(first).toBe(second)
    expect(first).toContain('up to date')
    expect(first).toContain(board.path)
    expect(() => assertBoardSchema(board.database)).not.toThrow()
  })

  it('refuses to migrate a host-like file — no marker, whatever tables it holds', async () => {
    const hostLikePath = join(projectDir, 'host.db')
    const hostLike = await openBoardDatabase(hostLikePath)
    migrateBoardFile(hostLike.database)
    seedHostWorkspace(hostLike, WORKSPACE.id, WORKSPACE.identifier)
    hostLike.close()

    const refusal = expect.objectContaining({ exitCode: 1, message: BOARD_FILE_NOT_MIGRATED_MESSAGE })
    await expect(runExactly(['migrate', '--db', hostLikePath])).rejects.toThrowError(refusal)
  })

  it('prints the role SQL without opening the file', async () => {
    const printed = await runExactly(['roles', 'print'])

    expect(printed).toContain('kanban_person')
    expect(printed).toContain('kanban_agent')
  })

  it('refuses roles apply on a file — the roles belong to an external Postgres board', async () => {
    const refusal = expect.objectContaining({ exitCode: 1, message: ROLES_NEED_A_DATABASE_MESSAGE })
    await expect(run(['roles', 'apply'])).rejects.toThrowError(refusal)
  })

  it('refuses a write to an own file older than this build, and points at kanbo migrate rather than a host app', async () => {
    const card = await createCard(store, { workspace: WORKSPACE, title: 'Card', statusName: 'To Do' }, USER)
    board.database.run(sql`update kanban_meta set revision = 0 where key = 'schema_epoch'`)

    const refusal = expect.objectContaining({ exitCode: 3, message: FILE_SCHEMA_OUTDATED_MESSAGE })
    await expect(run(['card', 'move', card.id, 'in_progress'])).rejects.toThrowError(refusal)
    expect((await store.issues.findById(card.id))?.statusId).toBe(card.statusId)
  })

  it('refuses to work an own file nothing on it can name a workspace for', async () => {
    // A separate project directory, with no binding at all — `projectDir`'s own
    // binding would otherwise still answer for it: resolution reads whichever
    // binding the working directory is under, not one tied to the db file.
    const strayDir = mkdtempSync(join(tmpdir(), 'kanbo-file-board-stray-'))
    const strayPath = join(strayDir, '.kanbo', 'board.db')
    mkdirSync(dirname(strayPath), { recursive: true })
    const stray = await openBoardDatabase(strayPath)
    migrateBoardFile(stray.database)
    markBoardFileOwnedByKanbo(stray.database)
    stray.close()
    vi.spyOn(process, 'cwd').mockReturnValue(strayDir)

    const refusal = expect.objectContaining({ exitCode: 2, message: FILE_WORKSPACE_NOT_RESOLVED_MESSAGE })
    await expect(runExactly(['card', 'list', '--db', strayPath])).rejects.toThrowError(refusal)

    rmSync(strayDir, { force: true, recursive: true })
  })

  it('refuses to number a card under a key an own file\'s binding does not give', async () => {
    writeBinding(projectDir, {
      schemaVersion: 1,
      workspaceId: WORKSPACE.id,
      boardId: null,
      dbPath: join('.kanbo', 'board.db'),
      identifier: null,
    })

    const refusal = expect.objectContaining({ exitCode: 2, message: FILE_IDENTIFIER_NOT_RESOLVED_MESSAGE })
    await expect(run(['card', 'list'])).rejects.toThrowError(refusal)
  })
})

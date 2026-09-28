import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PGlite } from '@electric-sql/pglite'
import { Command } from 'commander'
import { sql } from 'drizzle-orm'
import { migrate as migrateSqlite } from 'drizzle-orm/better-sqlite3/migrator'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BoardStore } from './board-store'
import { writeBinding } from './cli/binding'
import { registerKanboCommands } from './cli/commands'
import { overridePostgresOpenerForTests } from './cli/postgres-board'
import { createBoardOps } from './ops'
import { createPostgresBoardStore } from './postgres/board-store.postgres'
import { migrateBoardDatabase } from './postgres/migrate'
import { boardPostgresSchema } from './postgres/schema'
import { createSqliteBoardStore } from './sqlite/board-store.sqlite'
import { openBoardDatabase } from './sqlite/open-database'

/**
 * A board made by kanbo-cli 0.2.1 opens with this build: no migration error,
 * no "outdated" refusal, every card still there, and new writes go through.
 *
 * The boards are built with the migrations exactly as the v0.2.1 tag shipped
 * them (`src/testing/fixtures/v0.2.1/`, copied with `git show
 * v0.2.1:drizzle-sqlite/…` and `…drizzle-postgres/…`, snapshots left out), and
 * the file is marked as its own the way 0.2.1 marked it. Then this build's
 * commands run on it — and `kanbo migrate` applies whatever this build added
 * since. `scripts/smoke.mjs --upgrade` does the same with the published
 * package itself.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'testing', 'fixtures', 'v0.2.1')

/** A connection string shaped like a real one; the opener hands over PGlite instead. */
const DATABASE_URL = 'postgres://person:secret@board.example:5432/board'

const BOARD_VARIABLES = ['KANBO_DB_PATH', 'KANBO_DATABASE_URL', 'KANBO_WORKSPACE_ID', 'KANBO_ACTOR_KIND']

/**
 * A board in use, as 0.2.1 wrote it: the rows spelled out column by column
 * against the 0.2.1 tables, no code of this build involved. Columns; a parent
 * card with a sub-card; a card with a finished run, one with a run going and a
 * status line, one waiting for a person; comments, and field changes including
 * the status line's history. The same statements run on both engines — the
 * 0.2.1 migrations name every column alike.
 */
const BOARD_AS_0_2_1_WROTE_IT = `
  insert into "issue_statuses" ("id", "workspace_id", "name", "category", "order", "created_at") values
    ('st-backlog', 'upgrade', 'Backlog', 'backlog', 0, 1000),
    ('st-todo', 'upgrade', 'To Do', 'unstarted', 1, 1000),
    ('st-progress', 'upgrade', 'In Progress', 'started', 2, 1000),
    ('st-review', 'upgrade', 'In Review', 'started', 3, 1000),
    ('st-done', 'upgrade', 'Done', 'completed', 4, 1000);
  insert into "issues" ("id", "workspace_id", "number", "status_id", "parent_issue_id", "title", "description", "priority", "labels",
      "status_line", "waiting_for", "order", "created_at", "updated_at") values
    ('UPG-001', 'upgrade', 1, 'st-todo', null, 'Settings page', 'Group the preferences by section.', 'high', '["frontend"]', null, null, 0, 1000, 1500),
    ('UPG-002', 'upgrade', 2, 'st-todo', 'UPG-001', 'Section headers', null, 'none', '[]', null, null, 1, 1001, 1100),
    ('UPG-003', 'upgrade', 3, 'st-progress', 'UPG-001', 'Save path', null, 'medium', '[]', 'writing tests', null, 2, 1002, 1600),
    ('UPG-004', 'upgrade', 4, 'st-review', null, 'Keyboard order', null, 'none', '["frontend"]', 'done, please check', 'human', 3, 1003, 1700),
    ('UPG-005', 'upgrade', 5, 'st-done', null, 'Old shortcuts', null, 'low', '[]', null, null, 4, 1004, 1200);
  insert into "issue_comments" ("id", "issue_id", "content", "author_kind", "author_id", "created_at") values
    ('c-1', 'UPG-001', 'Started reading the code.', 'agent', 'claude', 1100),
    ('c-2', 'UPG-001', 'Keep the old shortcuts.', 'user', '__self__', 1200),
    ('c-3', 'UPG-004', 'Ready for a look.', 'agent', 'claude', 1700);
  insert into "issue_runs" ("id", "issue_id", "launched_by_kind", "agent_name", "execution_mode", "branch", "state", "started_at", "ended_at") values
    ('run-done', 'UPG-005', 'agent', 'claude', 'worktree', 'kanbo/upg-005', 'finished', 1150, 1190),
    ('run-going', 'UPG-003', 'agent', 'claude', 'worktree', 'kanbo/upg-003', 'running', 1550, null);
  insert into "issue_field_changes" ("id", "issue_id", "field", "from_value", "to_value", "actor_kind", "actor_id", "created_at") values
    ('f-1', 'UPG-001', 'statusId', 'st-backlog', 'st-todo', 'user', '__self__', 1300),
    ('f-2', 'UPG-001', 'priority', 'none', 'high', 'user', '__self__', 1400),
    ('f-3', 'UPG-003', 'statusLine', null, 'writing tests', 'agent', 'claude', 1600);
`

/** What this build reads off that board, the same on either engine. */
async function expectBoardReadsAsWritten(store: BoardStore, kanbo: (argv: string[]) => Promise<string>): Promise<void> {
  const ops = createBoardOps(store)
  const ids = (page: { cards: { id: string }[] }) => page.cards.map(card => card.id)

  expect(ids(await ops.queryCards({ workspaceId: 'upgrade' }))).toEqual(['UPG-001', 'UPG-002', 'UPG-003', 'UPG-004', 'UPG-005'])
  expect(ids(await ops.queryCards({ workspaceId: 'upgrade', waitingForPerson: true }))).toEqual(['UPG-004'])
  expect(ids(await ops.queryCards({ workspaceId: 'upgrade', hasActiveRun: true }))).toEqual(['UPG-003'])
  expect(ids(await ops.queryCards({ workspaceId: 'upgrade', parentIssueId: 'UPG-001' }))).toEqual(['UPG-002', 'UPG-003'])
  expect(ids(await ops.queryCards({ workspaceId: 'upgrade', labels: ['frontend'], columns: ['to_do', 'in_review'] }))).toEqual(['UPG-001', 'UPG-004'])
  expect(ids(await ops.queryCards({ workspaceId: 'upgrade', text: 'PREFERENCES' }))).toEqual(['UPG-001'])
  expect(ids(await ops.queryCards({ workspaceId: 'upgrade', updatedSince: 1_550 }))).toEqual(['UPG-003', 'UPG-004'])
  expect(ids(await ops.queryCards({ workspaceId: 'upgrade', priorities: ['high', 'low'] }))).toEqual(['UPG-001', 'UPG-005'])
  // Ready: To Do, nobody on it, nobody waited for — the sub-card in To Do too.
  expect(await ops.queryReady({ workspaceId: 'upgrade' })).toMatchObject({ total: 2, cards: [{ id: 'UPG-001' }, { id: 'UPG-002' }] })

  const parent = JSON.parse(await kanbo(['card', 'get', '1', '--include', 'comments,subCards,history', '--json']))
  expect(parent).toMatchObject({
    id: 'UPG-001',
    title: 'Settings page',
    description: 'Group the preferences by section.',
    priority: 'high',
    labels: ['frontend'],
    commentCount: 2,
    comments: [{ content: 'Started reading the code.' }, { content: 'Keep the old shortcuts.' }],
    subCards: [{ id: 'UPG-002' }, { id: 'UPG-003' }],
    history: [
      { field: 'statusId', from: 'st-backlog', to: 'st-todo' },
      { field: 'priority', from: 'none', to: 'high' },
    ],
  })
  const running = JSON.parse(await kanbo(['card', 'get', 'UPG-3', '--include', 'runs,history', '--json']))
  expect(running).toMatchObject({
    id: 'UPG-003',
    statusLine: 'writing tests',
    runs: [{ id: 'run-going', state: 'running', branch: 'kanbo/upg-003' }],
    history: [{ field: 'statusLine', to: 'writing tests' }],
  })
  const finished = JSON.parse(await kanbo(['card', 'get', 'UPG-005', '--include', 'runs', '--json']))
  expect(finished.runs).toMatchObject([{ id: 'run-done', state: 'finished', endedAt: 1190 }])
  const waiting = JSON.parse(await kanbo(['card', 'get', 'UPG-004', '--json']))
  expect(waiting).toMatchObject({ waitingFor: 'human', statusLine: 'done, please check', commentCount: 1 })
}

describe('a board made by kanbo 0.2.1', () => {
  let projectDir: string
  let printed: string[]

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'kanbo-upgrade-'))
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir)
    for (const name of BOARD_VARIABLES) {
      vi.stubEnv(name, undefined)
    }
    printed = []
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      printed.push(String(line))
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    overridePostgresOpenerForTests(null)
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    rmSync(projectDir, { force: true, recursive: true })
  })

  async function kanbo(argv: string[]): Promise<string> {
    printed = []
    const program = new Command().exitOverride()
    registerKanboCommands(program)
    await program.parseAsync(argv, { from: 'user' })
    return printed.join('\n')
  }

  /** The cards this build lists, with the fields a person reads. */
  async function listCards(): Promise<unknown> {
    return JSON.parse(await kanbo(['card', 'list', '--json', 'id,title,column']))
  }

  it('as a board file of the project\'s own', async () => {
    const path = join(projectDir, '.kanbo', 'board.db')
    mkdirSync(dirname(path), { recursive: true })
    const board = await openBoardDatabase(path)
    try {
      migrateSqlite(board.database, { migrationsFolder: join(FIXTURES, 'drizzle-sqlite') })
      // 0.2.1's `markBoardFileOwnedByKanbo`, word for word.
      board.database.run(sql`insert or ignore into kanban_meta (key, revision) values ('file_owner', 1)`)
    }
    finally {
      board.close()
    }
    writeBinding(projectDir, {
      schemaVersion: 1,
      workspaceId: 'upgrade',
      boardId: null,
      dbPath: join('.kanbo', 'board.db'),
      identifier: 'UPG',
    })

    await kanbo(['columns', 'add-standard'])
    await kanbo(['card', 'create', '--title', 'Written on the 0.2.1 schema'])
    await kanbo(['migrate'])
    await kanbo(['card', 'create', '--title', 'Written after kanbo migrate', '--column', 'to_do'])

    expect(await listCards()).toEqual([
      { id: 'UPG-001', title: 'Written on the 0.2.1 schema', column: 'Backlog' },
      { id: 'UPG-002', title: 'Written after kanbo migrate', column: 'To Do' },
    ])
    expect(JSON.parse(await kanbo(['ready', '--json', 'id']))).toEqual([{ id: 'UPG-002' }])
  })

  it('as a shared Postgres board', async () => {
    const client = await PGlite.create()
    try {
      const database = drizzle(client, { schema: boardPostgresSchema })
      await migratePglite(database, { migrationsFolder: join(FIXTURES, 'drizzle-postgres') })
      overridePostgresOpenerForTests(async () => ({
        database,
        migrate: async () => await migrateBoardDatabase(database),
        runScript: async (script: string) => {
          await client.exec(script)
        },
        close: async () => {},
      }))
      writeBinding(projectDir, {
        schemaVersion: 1,
        workspaceId: 'upgrade',
        boardId: null,
        dbPath: null,
        databaseUrl: DATABASE_URL,
        identifier: 'UPG',
      })

      await kanbo(['columns', 'add-standard'])
      await kanbo(['card', 'create', '--title', 'Written on the 0.2.1 schema'])
      await kanbo(['migrate'])
      await kanbo(['card', 'create', '--title', 'Written after kanbo migrate', '--column', 'to_do'])

      expect(await listCards()).toEqual([
        { id: 'UPG-001', title: 'Written on the 0.2.1 schema', column: 'Backlog' },
        { id: 'UPG-002', title: 'Written after kanbo migrate', column: 'To Do' },
      ])
    }
    finally {
      await client.close()
    }
  })

  it('reads what 0.2.1 wrote to a board file — cards, comments, runs, history, waiting — as it was written', async () => {
    const path = join(projectDir, '.kanbo', 'board.db')
    mkdirSync(dirname(path), { recursive: true })
    const setup = await openBoardDatabase(path)
    try {
      migrateSqlite(setup.database, { migrationsFolder: join(FIXTURES, 'drizzle-sqlite') })
      setup.database.run(sql`insert or ignore into kanban_meta (key, revision) values ('file_owner', 1)`)
      setup.connection.exec(BOARD_AS_0_2_1_WROTE_IT)
    }
    finally {
      setup.close()
    }
    writeBinding(projectDir, { schemaVersion: 1, workspaceId: 'upgrade', boardId: null, dbPath: join('.kanbo', 'board.db'), identifier: 'UPG' })

    const board = await openBoardDatabase(path)
    try {
      await expectBoardReadsAsWritten(createSqliteBoardStore({ database: () => board.database }), kanbo)
    }
    finally {
      board.close()
    }
  })

  it('reads what 0.2.1 wrote to a shared Postgres board as it was written', async () => {
    const client = await PGlite.create()
    try {
      const database = drizzle(client, { schema: boardPostgresSchema })
      await migratePglite(database, { migrationsFolder: join(FIXTURES, 'drizzle-postgres') })
      await client.exec(BOARD_AS_0_2_1_WROTE_IT)
      overridePostgresOpenerForTests(async () => ({
        database,
        migrate: async () => await migrateBoardDatabase(database),
        runScript: async (script: string) => {
          await client.exec(script)
        },
        close: async () => {},
      }))
      writeBinding(projectDir, { schemaVersion: 1, workspaceId: 'upgrade', boardId: null, dbPath: null, databaseUrl: DATABASE_URL, identifier: 'UPG' })

      await expectBoardReadsAsWritten(createPostgresBoardStore({ database }), kanbo)
    }
    finally {
      await client.close()
    }
  })
})

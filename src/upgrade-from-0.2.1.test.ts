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

import { writeBinding } from './cli/binding'
import { registerKanboCommands } from './cli/commands'
import { overridePostgresOpenerForTests } from './cli/postgres-board'
import { migrateBoardDatabase } from './postgres/migrate'
import { boardPostgresSchema } from './postgres/schema'
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
})

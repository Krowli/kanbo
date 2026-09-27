import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PGlite } from '@electric-sql/pglite'
import { Command } from 'commander'
import { drizzle } from 'drizzle-orm/pglite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BoardStore } from '../board-store'
import type { BoardWorkspaceIdentity } from '../domain/numbering'
import { createCard, waitApproval } from '../ops/cards'
import { readChangeSeq } from '../ops/change-seq'
import type { BoardActor } from '../ops/types'
import { createPostgresBoardStore } from '../postgres/board-store.postgres'
import { migrateBoardDatabase } from '../postgres/migrate'
import { BOARD_AGENT_ROLE, BOARD_PERSON_ROLE } from '../postgres/roles.sql'
import { boardPostgresSchema } from '../postgres/schema'
import type { TestPostgresDatabase } from '../testing/postgres-database'
import { createTestPostgresDatabase } from '../testing/postgres-database'
import { writeBinding } from './binding'
import { registerApproveCommand } from './commands/approve'
import { registerCardCommands } from './commands/card'
import { registerInitCommand } from './commands/init'
import { BOARD_FILE_NOT_MIGRATED_MESSAGE, registerMigrateCommand } from './commands/migrate'
import { registerRolesCommands, ROLES_NEED_A_DATABASE_MESSAGE } from './commands/roles'
import type { OpenPostgresBoard } from './postgres-board'
import { overridePostgresOpenerForTests } from './postgres-board'
import { SCHEMA_NOT_INSTALLED_MESSAGE } from './schema-guard'
import { EXTERNAL_IDENTIFIER_NOT_RESOLVED_MESSAGE, EXTERNAL_WORKSPACE_NOT_RESOLVED_MESSAGE } from './workspace'

/**
 * The command line on a board that is a database of its own.
 *
 * The commands run in this process, as they do everywhere else here, and the
 * board they reach is the embedded Postgres — which listens on no socket, so
 * there is no connection string that could name it. The opener is handed over
 * instead; the connection string below is a fiction, and every command still
 * resolves it exactly as it would a real one.
 */

const WORKSPACE: BoardWorkspaceIdentity = { id: 'workspace', identifier: 'WOR', name: 'WOR' }
const AGENT: BoardActor = { kind: 'agent', id: 'agent-1' }

/** A connection string shaped like a real one, pointing nowhere. */
const DATABASE_URL = 'postgres://user:secret@board.example:5432/board'

/** The same board, as the agent role logs into it. */
const AGENT_DATABASE_URL = 'postgres://kanban_agent:other@board.example:5432/board'

/** The variable that marks a shell as an agent's. */
const AGENT_SHELL = ['KANBO_ACTOR_KIND']

/** Nothing in the environment may decide which board these tests are about. */
const BOARD_VARIABLES = ['KANBO_DB_PATH', 'KANBO_DATABASE_URL', 'KANBO_WORKSPACE_ID']

/** A Postgres with no board in it at all — what a connection string names before `kanbo migrate`. */
async function createEmptyPostgresDatabase(): Promise<TestPostgresDatabase> {
  const client = await PGlite.create()
  return {
    client,
    database: drizzle(client, { schema: boardPostgresSchema }),
    // There is no board here to empty — that is the whole point of this one.
    reset: async () => {},
    dispose: async () => {
      await client.close()
    },
  }
}

describe('the command line on an external board', () => {
  let projectDir: string
  let board: TestPostgresDatabase
  let openedUrls: string[]

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'kanbo-postgres-'))
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir)
    for (const name of [...AGENT_SHELL, ...BOARD_VARIABLES]) {
      vi.stubEnv(name, undefined)
    }
    openedUrls = []
  })

  afterEach(async () => {
    overridePostgresOpenerForTests(null)
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    await board.dispose()
    rmSync(projectDir, { force: true, recursive: true })
  })

  /** Bind the project to the external board, the way `kanbo init --database-url` does. */
  function bindProject(fields: { identifier?: string | null, agentDatabaseUrl?: string } = {}): void {
    writeBinding(projectDir, {
      schemaVersion: 1,
      workspaceId: WORKSPACE.id,
      boardId: null,
      dbPath: null,
      databaseUrl: DATABASE_URL,
      identifier: 'identifier' in fields ? fields.identifier : WORKSPACE.identifier,
      ...(fields.agentDatabaseUrl ? { agentDatabaseUrl: fields.agentDatabaseUrl } : {}),
    })
  }

  /** Hand the commands this board instead of a connection. */
  function serve(opened: TestPostgresDatabase): void {
    overridePostgresOpenerForTests(async (url): Promise<OpenPostgresBoard> => {
      openedUrls.push(url)
      return {
        database: opened.database,
        migrate: async () => await migrateBoardDatabase(opened.database),
        runScript: async (script: string) => {
          await opened.client.exec(script)
        },
        close: async () => {},
      }
    })
  }

  /** A board with the schema already applied, bound to the project. */
  async function boardWithSchema(): Promise<BoardStore> {
    board = await createTestPostgresDatabase()
    serve(board)
    bindProject()
    return createPostgresBoardStore({ database: board.database })
  }

  async function run(argv: string[]): Promise<string> {
    return await runExactly([...argv, '--database-url', DATABASE_URL])
  }

  /** The same, with only the arguments given — for the commands that must refuse a board file. */
  async function runExactly(argv: string[]): Promise<string> {
    const printed: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      printed.push(String(line))
    })
    const program = new Command().exitOverride()
    registerCardCommands(program)
    registerInitCommand(program)
    registerApproveCommand(program)
    registerMigrateCommand(program)
    registerRolesCommands(program)
    await program.parseAsync(argv, { from: 'user' })
    return printed.join('\n')
  }

  it('numbers a card with the key the binding says, and reads it back', async () => {
    await boardWithSchema()

    await run(['card', 'create', '--title', 'First card'])
    const printed = await run(['card', 'list', '--json', 'id,title,column'])

    expect(JSON.parse(printed)).toEqual([{ id: 'WOR-001', title: 'First card', column: 'Backlog' }])
    expect(openedUrls).toEqual([DATABASE_URL, DATABASE_URL])
  })

  it('moves a card, and tells every reader the board changed', async () => {
    const store = await boardWithSchema()
    await run(['card', 'create', '--title', 'First card'])
    const before = await readChangeSeq(store)

    await run(['card', 'move', 'WOR-001', 'in_progress'])

    const printed = await run(['card', 'get', 'WOR-1', '--json', 'columnSlug'])
    expect(JSON.parse(printed)).toEqual({ columnSlug: 'in_progress' })
    expect(await readChangeSeq(store)).toBe(before + 1)
  })

  it('refuses an approval in a shell started for an agent, and leaves the card waiting', async () => {
    const store = await boardWithSchema()
    const card = await createCard(store, { workspace: WORKSPACE, title: 'Card', statusName: 'In Review' }, AGENT)
    await waitApproval(store, card.id, { statusLine: 'need a person' }, AGENT)
    const before = await readChangeSeq(store)
    vi.stubEnv('KANBO_ACTOR_KIND', 'agent')

    await expect(run(['approve', card.id])).rejects.toThrowError(expect.objectContaining({ exitCode: 4 }))

    expect((await store.issues.findById(card.id))?.waitingFor).toBe('human')
    expect(await store.comments.listByIssue(card.id)).toHaveLength(0)
    expect(await readChangeSeq(store)).toBe(before)
  })

  it('accepts the same approval from a person\'s own terminal', async () => {
    const store = await boardWithSchema()
    const card = await createCard(store, { workspace: WORKSPACE, title: 'Card', statusName: 'In Review' }, AGENT)
    await waitApproval(store, card.id, { statusLine: 'need a person' }, AGENT)

    await run(['approve', card.id, '--comment', 'Looks right'])

    expect((await store.issues.findById(card.id))?.waitingFor).toBeNull()
    expect((await store.comments.listByIssue(card.id)).map(comment => comment.authorKind))
      .toContain('system.approved')
  })

  it('refuses every command against a database that holds no board yet', async () => {
    board = await createEmptyPostgresDatabase()
    serve(board)
    bindProject()

    const refusal = expect.objectContaining({ exitCode: 3, message: SCHEMA_NOT_INSTALLED_MESSAGE })
    await expect(run(['card', 'list'])).rejects.toThrowError(refusal)
    await expect(run(['card', 'create', '--title', 'Card'])).rejects.toThrowError(refusal)
  })

  it('creates the board with migrate, and says the same thing the second time', async () => {
    board = await createEmptyPostgresDatabase()
    serve(board)
    bindProject()

    const first = await run(['migrate'])
    const second = await run(['migrate'])

    expect(first).toBe(second)
    expect(first).toContain('up to date')
    // Never the password, in the one line that names the board it migrated.
    expect(first).toContain('postgres://user:***@board.example:5432/board')
    expect(first).not.toContain('secret')
    expect(JSON.parse(await run(['card', 'list', '--json', 'id']))).toEqual([])
  })

  it('init --migrate creates the tables, puts the chosen columns on the board, and its first card in To Do', async () => {
    board = await createEmptyPostgresDatabase()
    serve(board)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const printed = await runExactly([
      'init', '--yes', '--database-url', DATABASE_URL, '--workspace', 'weather', '--key', 'WEA',
      '--migrate', '--columns', 'simple', '--first-card', 'Calibrate the sensors',
    ])

    expect(printed).toContain('Columns: To Do, In Progress, Done')
    expect(printed).toContain('First card: WEA-001 Calibrate the sensors')
    const store = createPostgresBoardStore({ database: board.database })
    expect((await store.statuses.listByWorkspace('weather')).map(column => column.name)).toEqual(['To Do', 'In Progress', 'Done'])
    expect(JSON.parse(await run(['card', 'list', '--json', 'id,column']))).toEqual([{ id: 'WEA-001', column: 'To Do' }])
  })

  it('refuses both of its own commands on a board file, which is a host app\'s to look after', async () => {
    board = await createEmptyPostgresDatabase()
    serve(board)
    const file = join(projectDir, 'host.db')
    writeFileSync(file, '')

    const noMigration = expect.objectContaining({ exitCode: 1, message: BOARD_FILE_NOT_MIGRATED_MESSAGE })
    const noRoles = expect.objectContaining({ exitCode: 1, message: ROLES_NEED_A_DATABASE_MESSAGE })
    await expect(runExactly(['migrate', '--db', file])).rejects.toThrowError(noMigration)
    await expect(runExactly(['roles', 'apply', '--db', file])).rejects.toThrowError(noRoles)
    expect(openedUrls).toEqual([])
  })

  it('prints the role SQL without opening anything', async () => {
    board = await createEmptyPostgresDatabase()
    serve(board)

    // No board flags at all: it resolves nothing, so it takes nothing.
    const printed = await runExactly(['roles', 'print'])

    expect(printed).toContain(BOARD_PERSON_ROLE)
    expect(printed).toContain(BOARD_AGENT_ROLE)
    expect(openedUrls).toEqual([])
  })

  it('refuses to work without a workspace nothing on this board can name', async () => {
    board = await createTestPostgresDatabase()
    serve(board)

    // No binding, no --workspace, no KANBO_WORKSPACE_ID: an external board
    // holds no `workspaces` table to look the answer up in.
    const refusal = expect.objectContaining({ exitCode: 2, message: EXTERNAL_WORKSPACE_NOT_RESOLVED_MESSAGE })
    await expect(run(['card', 'list'])).rejects.toThrowError(refusal)
  })

  it('refuses to number a card under a key the binding does not give', async () => {
    board = await createTestPostgresDatabase()
    serve(board)
    bindProject({ identifier: null })

    const refusal = expect.objectContaining({ exitCode: 2, message: EXTERNAL_IDENTIFIER_NOT_RESOLVED_MESSAGE })
    await expect(run(['card', 'list'])).rejects.toThrowError(refusal)

    // And the binding's key is only good for the workspace the binding is
    // about: another one would print this project's prefix on its cards.
    bindProject()
    await expect(run(['card', 'list', '--workspace', 'another-workspace'])).rejects.toThrowError(refusal)
  })

  it('migrates as the owner even from an agent\'s shell, because the agent may not create a table', async () => {
    board = await createEmptyPostgresDatabase()
    serve(board)
    bindProject({ agentDatabaseUrl: AGENT_DATABASE_URL })
    vi.stubEnv('KANBO_ACTOR_KIND', 'agent')

    await runExactly(['migrate'])

    expect(openedUrls).toEqual([DATABASE_URL])
  })

  it('applies the roles to the board, and says what is left to do about their passwords', async () => {
    await boardWithSchema()

    const printed = await run(['roles', 'apply'])

    const roles = await board.client.query<{ rolname: string }>(
      `select rolname from pg_catalog.pg_roles where rolname in ($1, $2) order by rolname`,
      [BOARD_PERSON_ROLE, BOARD_AGENT_ROLE],
    )
    expect(roles.rows.map(row => row.rolname)).toEqual([BOARD_AGENT_ROLE, BOARD_PERSON_ROLE])
    expect(printed).toContain('alter role')
    expect(printed).not.toContain('secret')
  })

  it('applies the roles as the owner even from an agent\'s shell, because the agent may not grant them', async () => {
    // The twin of the `migrate` scenario above, and for the same reason: both
    // are administrative commands, so neither may take the agent's connection
    // string just because the shell it was typed in belongs to an agent.
    await boardWithSchema()
    bindProject({ agentDatabaseUrl: AGENT_DATABASE_URL })
    vi.stubEnv('KANBO_ACTOR_KIND', 'agent')

    await runExactly(['roles', 'apply'])

    expect(openedUrls).toEqual([DATABASE_URL])
  })
})

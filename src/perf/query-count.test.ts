import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BoardStore } from '../board-store'
import { writeBinding } from '../cli/binding'
import type { BoardSession } from '../cli/command'
import { overridePostgresOpenerForTests } from '../cli/postgres-board'
import { createKanboProgram } from '../cli/program'
import { createDbTransport } from '../mcp/db-transport'
import { createKanboMcpServer } from '../mcp/server'
import { createBoardOps } from '../ops'
import { createPostgresBoardStore } from '../postgres/board-store.postgres'
import { migrateBoardDatabase } from '../postgres/migrate'
import { startKanboServer } from '../serve/server'
import { createSqliteBoardStore } from '../sqlite/board-store.sqlite'
import { createTestBoardDatabase, seedHostWorkspace } from '../testing/board-database'
import { createTestPostgresDatabase } from '../testing/postgres-database'
import type { QueryCounter } from './query-counter'
import { countQueriesOfNewBoardHandles, createQueryCounter } from './query-counter'
import { SEED_LABEL, SEED_PARENT_NUMBER, SEED_WORKSPACE, seedBoard } from './seed-board'

/**
 * The statements each read an agent or a person makes most often costs, on a
 * board of 10 cards and on one of 50: a read that asks the database once per
 * card (an N+1) costs more on the bigger board, and fails here.
 *
 * Every surface is driven the way it is used — the command line in-process,
 * the MCP tools through an in-memory client, `kanbo serve` over HTTP — on both
 * engines, with the statement counter on the board handle each one opens.
 */

const SMALL = 10
const LARGE = 50

/** A connection string shaped like a real one; the opener below answers it with the embedded Postgres. */
const DATABASE_URL = 'postgres://user:secret@board.example:5432/board'

/** Nothing in the environment may decide which board these tests are about. */
const BOARD_VARIABLES = ['KANBO_DB_PATH', 'KANBO_DATABASE_URL', 'KANBO_WORKSPACE_ID', 'KANBO_ACTOR_KIND', 'CLAUDECODE']

interface OpenBoard {
  store: BoardStore
  /** The target options every command is given. */
  target: string[]
  /** What `createDbTransport` is given to open the same board. */
  transportTarget: { dbPath?: string, databaseUrl?: string }
  dispose: () => Promise<void>
}

type Engine = 'sqlite' | 'postgres'

/** A board of `count` cards, every handle onto it counting into `counter`. */
async function openBoard(engine: Engine, count: number, counter: QueryCounter, projectDir: string): Promise<OpenBoard> {
  countQueriesOfNewBoardHandles(counter)
  if (engine === 'sqlite') {
    const board = await createTestBoardDatabase()
    seedHostWorkspace(board, SEED_WORKSPACE.id, SEED_WORKSPACE.identifier)
    const store = createSqliteBoardStore({ database: () => board.database })
    await seedBoard(store, count)
    return {
      store,
      target: ['--db', board.path, '--workspace', SEED_WORKSPACE.id],
      transportTarget: { dbPath: board.path },
      dispose: async () => board.dispose(),
    }
  }

  const board = await createTestPostgresDatabase()
  overridePostgresOpenerForTests(async () => ({
    database: board.database,
    migrate: async () => await migrateBoardDatabase(board.database),
    runScript: async (script: string) => {
      await board.client.exec(script)
    },
    close: async () => {},
  }))
  // An external board holds no `workspaces` table: the binding names the workspace.
  writeBinding(projectDir, {
    schemaVersion: 1,
    workspaceId: SEED_WORKSPACE.id,
    boardId: null,
    dbPath: null,
    databaseUrl: DATABASE_URL,
    identifier: SEED_WORKSPACE.identifier,
  })
  const store = createPostgresBoardStore({ database: board.database })
  await seedBoard(store, count)
  return {
    store,
    target: ['--database-url', DATABASE_URL],
    transportTarget: { databaseUrl: DATABASE_URL },
    dispose: board.dispose,
  }
}

/** Statements each surface ran, by name. */
type Counts = Record<string, number>

/** The seeded parent, as an agent names it. */
const PARENT_KEY = `${SEED_WORKSPACE.identifier}-${String(SEED_PARENT_NUMBER).padStart(3, '0')}`

interface Measured {
  counts: Counts
  statements: Record<string, readonly string[]>
  /** How many cards the reads whose answer is a list of cards found — a filter that finds none proves nothing. */
  rows: Counts
}

async function measureSurfaces(engine: Engine, count: number, projectDir: string): Promise<Measured> {
  const counter = createQueryCounter()
  const board = await openBoard(engine, count, counter, projectDir)
  const counts: Counts = {}
  const statements: Record<string, readonly string[]> = {}
  const rows: Counts = {}
  const measure = async (name: string, body: () => Promise<unknown>): Promise<void> => {
    counter.reset()
    await body()
    counts[name] = counter.count
    statements[name] = counter.statements
  }

  try {
    // The command line, in this process, as a shell would type it.
    const kanbo = async (...args: string[]): Promise<void> => {
      const program = createKanboProgram().exitOverride()
      await program.parseAsync([...args, ...board.target], { from: 'user' })
    }
    await measure('cli card list', async () => await kanbo('card', 'list'))
    await measure('cli card list, filtered', async () => await kanbo(
      'card',
      'list',
      '--column',
      'to_do,in_review',
      '--parent',
      PARENT_KEY,
      '--text',
      'SETTINGS',
      '--updated-since',
      '2020-01-01',
      '--label',
      SEED_LABEL,
      '--priority',
      'none,high',
      '--limit',
      '5',
      '--json',
      'id',
    ))
    rows['cli card list, filtered'] = (JSON.parse(String(vi.mocked(console.log).mock.lastCall?.[0])) as unknown[]).length
    await measure('cli ready', async () => await kanbo('ready'))
    await measure('cli prime', async () => await kanbo('prime'))
    await measure('cli card get', async () => await kanbo('card', 'get', PARENT_KEY))
    await measure('cli board', async () => await kanbo('board'))

    // The same board's operations, the way a host calls them: a card with its comments.
    const ops = createBoardOps(board.store)
    await measure('ops card get + comments', async () => {
      const card = await board.store.issues.findByNumber(SEED_WORKSPACE.id, SEED_PARENT_NUMBER)
      await Promise.all([
        ops.listColumns(SEED_WORKSPACE.id),
        ops.readBoardProjectionForIssue(card!.id),
        ops.listComments(card!.id),
      ])
    })

    // The MCP tools, through a client on the other end of an in-memory pipe.
    const transport = await createDbTransport({
      ...board.transportTarget,
      workspaceId: SEED_WORKSPACE.id,
      actor: { kind: 'agent', id: 'claude' },
    })
    const server = createKanboMcpServer(transport, { includeRunTools: true })
    const client = new Client({ name: 'query-count', version: '1.0.0' })
    const [clientChannel, serverChannel] = InMemoryTransport.createLinkedPair()
    await Promise.all([client.connect(clientChannel), server.connect(serverChannel)])
    try {
      let answer: { cards?: unknown[], subCards?: unknown[] } = {}
      const tool = async (name: string, args: Record<string, unknown> = {}): Promise<void> => {
        const result = await client.callTool({ name, arguments: args })
        expect(result.isError, JSON.stringify(result.content)).toBeFalsy()
        const [content] = result.content as { type: string, text: string }[]
        answer = content?.type === 'text' && content.text.startsWith('{') ? JSON.parse(content.text) : {}
      }
      await measure('mcp kanbo_card_list', async () => await tool('kanbo_card_list'))
      await measure('mcp kanbo_ready', async () => await tool('kanbo_ready'))
      await measure('mcp kanbo_prime', async () => await tool('kanbo_prime'))
      await measure('mcp kanbo_card_list, filtered', async () => await tool('kanbo_card_list', {
        columns: ['to_do', 'in_review'],
        waitingForPerson: false,
        hasActiveRun: false,
        parent: PARENT_KEY,
        text: 'settings',
        updatedSince: '2020-01-01T00:00:00Z',
        labels: [SEED_LABEL],
        priority: ['none', 'high'],
        limit: 5,
        fields: ['description'],
      }))
      rows['mcp kanbo_card_list, filtered'] = answer.cards?.length ?? 0
      await measure('mcp kanbo_card_get', async () => await tool('kanbo_card_get', { card: PARENT_KEY }))
      rows['mcp kanbo_card_get sub-cards'] = answer.subCards?.length ?? 0
      await measure('mcp kanbo_card_get, everything', async () => await tool('kanbo_card_get', {
        card: PARENT_KEY,
        include: ['comments', 'subCards', 'runs', 'history', 'prs'],
      }))
      rows['mcp kanbo_card_get, everything sub-cards'] = answer.subCards?.length ?? 0
      await measure('mcp kanbo_sprints', async () => await tool('kanbo_sprints'))
    }
    finally {
      await client.close()
      await transport.close()
    }

    // `kanbo serve`, over HTTP.
    const session: BoardSession = {
      ops: createBoardOps(board.store),
      store: board.store,
      workspace: SEED_WORKSPACE,
      assertWritable: async () => {},
    }
    const running = await startKanboServer({
      session,
      actors: { writer: { kind: 'external', id: null }, person: null },
      host: '127.0.0.1',
      port: 0,
    })
    try {
      const get = async (path: string): Promise<void> => {
        const response = await fetch(`${running.url}${path}`)
        expect(response.status, await response.clone().text()).toBe(200)
        await response.json()
      }
      await measure('serve GET /issues', async () => await get('/issues'))
      const card = await board.store.issues.findByNumber(SEED_WORKSPACE.id, SEED_PARENT_NUMBER)
      await measure('serve GET /issues/:id/comments', async () => await get(`/issues/${card!.id}/comments`))
    }
    finally {
      await running.close()
    }
  }
  finally {
    countQueriesOfNewBoardHandles(null)
    overridePostgresOpenerForTests(null)
    await board.dispose()
  }
  return { counts, statements, rows }
}

describe.each<Engine>(['sqlite', 'postgres'])('statements per read on %s', (engine) => {
  let projectDir: string

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'kanbo-query-count-'))
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir)
    for (const name of BOARD_VARIABLES) {
      vi.stubEnv(name, undefined)
    }
    vi.stubEnv('KANBO_NO_UPDATE_CHECK', '1')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    rmSync(projectDir, { force: true, recursive: true })
  })

  it(`costs the same on ${SMALL} cards as on ${LARGE}`, async () => {
    const small = await measureSurfaces(engine, SMALL, projectDir)
    const large = await measureSurfaces(engine, LARGE, projectDir)

    for (const [name, count] of Object.entries(large.counts)) {
      expect(count, `${name}: ${count} statements on ${LARGE} cards, ${small.counts[name]} on ${SMALL}\n${large.statements[name]!.join('\n')}`)
        .toBe(small.counts[name])
    }
    expect(large.counts).toEqual(QUERY_BUDGETS[engine])

    // The filtered reads and the sub-cards found cards on both boards, and more
    // of them on the bigger one: the counts above are of reads that returned rows.
    expect(small.rows).toEqual(SMALL_ROWS)
    expect(large.rows).toEqual(LARGE_ROWS)
  })
})

/** Cards the seeded board answers the filtered reads with, on 10 cards and on 50. */
const SMALL_ROWS: Counts = {
  'cli card list, filtered': 1,
  'mcp kanbo_card_list, filtered': 1,
  'mcp kanbo_card_get sub-cards': 2,
  'mcp kanbo_card_get, everything sub-cards': 2,
}
const LARGE_ROWS: Counts = {
  // One more than the tool: the command line asks nothing of waiting, so the
  // sub-card waiting in review counts.
  'cli card list, filtered': 3,
  'mcp kanbo_card_list, filtered': 2,
  'mcp kanbo_card_get sub-cards': 12,
  'mcp kanbo_card_get, everything sub-cards': 12,
}

/**
 * What each read costs today, on either board size. A change that adds a
 * statement to one of them shows up here, and is either a regression or a new
 * number to write down.
 */
const QUERY_BUDGETS: Record<Engine, Counts> = {
  // 0.3.0: two more per list (which cards were returned, and the last comment
  // of the waiting and returned ones), two more per ready (the returned cards
  // listed first) and one more per prime (the same, said first).
  sqlite: {
    'cli card list': 6,
    'cli card list, filtered': 7,
    'cli ready': 6,
    'cli prime': 3,
    'cli card get': 6,
    'cli board': 4,
    'ops card get + comments': 5,
    'mcp kanbo_card_list': 5,
    'mcp kanbo_card_list, filtered': 6,
    'mcp kanbo_ready': 5,
    'mcp kanbo_prime': 2,
    'mcp kanbo_card_get': 5,
    'mcp kanbo_card_get, everything': 8,
    'mcp kanbo_sprints': 3,
    'serve GET /issues': 2,
    'serve GET /issues/:id/comments': 3,
  },
  // Two more per command: the schema guard an external board is opened behind.
  postgres: {
    'cli card list': 8,
    'cli card list, filtered': 9,
    'cli ready': 8,
    'cli prime': 5,
    'cli card get': 8,
    'cli board': 6,
    'ops card get + comments': 5,
    'mcp kanbo_card_list': 5,
    'mcp kanbo_card_list, filtered': 6,
    'mcp kanbo_ready': 5,
    'mcp kanbo_prime': 2,
    'mcp kanbo_card_get': 5,
    'mcp kanbo_card_get, everything': 8,
    'mcp kanbo_sprints': 3,
    'serve GET /issues': 2,
    'serve GET /issues/:id/comments': 3,
  },
}

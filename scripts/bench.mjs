#!/usr/bin/env node
// How fast kanbo answers on boards of 100, 1,000 and 10,000 cards, how many
// statements each read runs, and how big each MCP tool's answer is. Prints a
// markdown report (docs/performance.md is written from one).
//
//   npm run bench                                   # every size, both engines
//   npm run bench -- --sizes 1000 --engines sqlite  # one size, one engine
//   npm run bench -- --iterations 10 --out bench.md # fewer samples, report to a file
//   npm run bench -- --no-spawn                     # skip the timings of a spawned `kanbo`
//
// Runs the TypeScript sources through tsx; the spawned-CLI timings run the
// built `dist/cli.cjs`, so `npm run build` first. The boards are SQLite files
// in a temporary folder and Postgres boards in PGlite (Postgres compiled to
// WebAssembly, in this process), seeded through kanbo's own operations.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, platform, release, tmpdir, totalmem } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import { writeBinding } from '../src/cli/binding.ts'
import { overridePostgresOpenerForTests } from '../src/cli/postgres-board.ts'
import { createKanboProgram } from '../src/cli/program.ts'
import { createDbTransport } from '../src/mcp/db-transport.ts'
import { createKanboMcpServer } from '../src/mcp/server.ts'
import { createBoardOps } from '../src/ops/index.ts'
import { countQueriesOfNewBoardHandles, createQueryCounter } from '../src/perf/query-counter.ts'
import { SEED_WORKSPACE, seedBoard } from '../src/perf/seed-board.ts'
import { createPostgresBoardStore } from '../src/postgres/board-store.postgres.ts'
import { migrateBoardDatabase } from '../src/postgres/migrate.ts'
import { startKanboServer } from '../src/serve/server.ts'
import { createSqliteBoardStore } from '../src/sqlite/board-store.sqlite.ts'
import { createTestBoardDatabase, seedHostWorkspace } from '../src/testing/board-database.ts'
import { createTestPostgresDatabase } from '../src/testing/postgres-database.ts'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(REPO, 'dist', 'cli.cjs')
const DATABASE_URL = 'postgres://bench@board.example:5432/board'
const PERSON = { kind: 'user', id: '__self__' }

// ---------------------------------------------------------------- options

const args = process.argv.slice(2)
function option(name, fallback) {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}
const sizes = option('sizes', '100,1000,10000').split(',').map(Number)
const engines = option('engines', 'sqlite,postgres').split(',')
const iterations = Number(option('iterations', '20'))
const spawnIterations = Number(option('spawn-iterations', '5'))
const payloadSizes = option('payload-sizes', '100,1000').split(',').map(Number)
const out = option('out', null)
const spawnWanted = !args.includes('--no-spawn')

for (const name of ['KANBO_DB_PATH', 'KANBO_DATABASE_URL', 'KANBO_WORKSPACE_ID', 'KANBO_ACTOR_KIND', 'CLAUDECODE', 'CODEX_SANDBOX']) {
  delete process.env[name]
}
process.env.KANBO_NO_UPDATE_CHECK = '1'

// ---------------------------------------------------------------- timing

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

/** p50/p95 of `body` over `count` runs after one warm-up, and the statements the last run took. */
async function time(counter, count, body) {
  await body(0)
  const samples = []
  let statements = 0
  for (let index = 1; index <= count; index++) {
    counter.reset()
    const start = performance.now()
    await body(index)
    samples.push(performance.now() - start)
    statements = counter.count
  }
  samples.sort((a, b) => a - b)
  return { p50: percentile(samples, 50), p95: percentile(samples, 95), statements }
}

const ms = value => value < 10 ? value.toFixed(2) : value.toFixed(1)

// ---------------------------------------------------------------- boards

/** Console output of the in-process commands goes nowhere while they are timed. */
async function quietly(body) {
  const log = console.log
  const error = console.error
  console.log = () => {}
  console.error = () => {}
  try {
    return await body()
  }
  finally {
    console.log = log
    console.error = error
  }
}

async function openBoard(engine, size, counter, projectDir) {
  countQueriesOfNewBoardHandles(counter)
  if (engine === 'sqlite') {
    const board = await createTestBoardDatabase()
    seedHostWorkspace(board, SEED_WORKSPACE.id, SEED_WORKSPACE.identifier)
    const store = createSqliteBoardStore({ database: () => board.database })
    const seeded = performance.now()
    await seedBoard(store, size)
    return {
      store,
      seedMs: performance.now() - seeded,
      path: board.path,
      target: ['--db', board.path, '--workspace', SEED_WORKSPACE.id],
      transportTarget: { dbPath: board.path },
      dispose: async () => board.dispose(),
    }
  }

  const board = await createTestPostgresDatabase()
  overridePostgresOpenerForTests(async () => ({
    database: board.database,
    migrate: async () => await migrateBoardDatabase(board.database),
    runScript: async script => void await board.client.exec(script),
    close: async () => {},
  }))
  writeBinding(projectDir, {
    schemaVersion: 1,
    workspaceId: SEED_WORKSPACE.id,
    boardId: null,
    dbPath: null,
    databaseUrl: DATABASE_URL,
    identifier: SEED_WORKSPACE.identifier,
  })
  const store = createPostgresBoardStore({ database: board.database })
  const seeded = performance.now()
  await seedBoard(store, size)
  return {
    store,
    seedMs: performance.now() - seeded,
    path: null,
    target: ['--database-url', DATABASE_URL],
    transportTarget: { databaseUrl: DATABASE_URL },
    dispose: async () => {
      overridePostgresOpenerForTests(null)
      await board.dispose()
    },
  }
}

// ---------------------------------------------------------------- one board

async function benchBoard(engine, size) {
  const projectDir = mkdtempSync(join(tmpdir(), 'kanbo-bench-'))
  const cwd = process.cwd()
  process.chdir(projectDir)
  const counter = createQueryCounter()
  const board = await openBoard(engine, size, counter, projectDir)
  const rows = []
  const payloads = []
  const record = (surface, operation, result) => rows.push({ engine, size, surface, operation, ...result })
  const ops = createBoardOps(board.store)
  // Card numbers the reads and moves use: one of every column's, spread over the board.
  const cardNumber = index => 1 + ((index * 7919) % size)

  try {
    // The operations, as a host app calls them.
    record('ops', 'create card', await time(counter, iterations, async index =>
      await ops.createCard({ workspace: SEED_WORKSPACE, title: `Bench card ${index}`, description: 'x'.repeat(200) }, PERSON)))
    record('ops', 'move card', await time(counter, iterations, async (index) => {
      const card = await board.store.issues.findByNumber(SEED_WORKSPACE.id, cardNumber(index))
      await ops.moveCard(card.id, index % 2 === 0 ? 'In Progress' : 'To Do', PERSON)
    }))
    record('ops', 'list cards', await time(counter, iterations, async () => {
      const cards = await board.store.issues.listInBoardOrder(SEED_WORKSPACE.id)
      await ops.readBoardProjectionForIssues(cards.map(card => card.id))
    }))
    record('ops', 'ready', await time(counter, iterations, async () => await ops.listReady({ workspaceId: SEED_WORKSPACE.id })))
    record('ops', 'prime', await time(counter, iterations, async () => await ops.buildPrimeText(SEED_WORKSPACE.id)))
    record('ops', 'card get + comments', await time(counter, iterations, async (index) => {
      const card = await board.store.issues.findByNumber(SEED_WORKSPACE.id, cardNumber(index))
      await Promise.all([ops.listColumns(SEED_WORKSPACE.id), ops.readBoardProjectionForIssue(card.id), ops.listComments(card.id)])
    }))

    // The command line, in this process: what a command costs without Node starting up.
    const kanbo = async (...words) => await quietly(async () =>
      await createKanboProgram().exitOverride().parseAsync([...words, ...board.target], { from: 'user' }))
    record('cli (in-process)', 'card list', await time(counter, iterations, async () => await kanbo('card', 'list')))
    record('cli (in-process)', 'card list --column in_progress', await time(counter, iterations, async () => await kanbo('card', 'list', '--column', 'in_progress')))
    record('cli (in-process)', 'ready', await time(counter, iterations, async () => await kanbo('ready')))
    record('cli (in-process)', 'prime', await time(counter, iterations, async () => await kanbo('prime')))
    record('cli (in-process)', 'card get', await time(counter, iterations, async index => await kanbo('card', 'get', String(cardNumber(index)))))
    record('cli (in-process)', 'board', await time(counter, iterations, async () => await kanbo('board')))

    // The MCP tools, through a client on an in-memory pipe.
    const transport = await createDbTransport({ ...board.transportTarget, workspaceId: SEED_WORKSPACE.id, actor: { kind: 'agent', id: 'bench' } })
    const server = createKanboMcpServer(transport, { includeRunTools: true })
    const client = new Client({ name: 'bench', version: '1.0.0' })
    const [clientChannel, serverChannel] = InMemoryTransport.createLinkedPair()
    await Promise.all([client.connect(clientChannel), server.connect(serverChannel)])
    try {
      const tool = async (name, input = {}) => {
        const result = await client.callTool({ name, arguments: input })
        if (result.isError) {
          throw new Error(`${name}: ${JSON.stringify(result.content)}`)
        }
        return result.content.map(part => part.text ?? '').join('')
      }
      // [row label, tool, arguments]: the defaults an agent calls with, and the filtered and full reads.
      const readTools = [
        ['kanbo_prime', 'kanbo_prime', () => ({})],
        ['kanbo_ready', 'kanbo_ready', () => ({})],
        ['kanbo_columns', 'kanbo_columns', () => ({})],
        ['kanbo_card_list', 'kanbo_card_list', () => ({})],
        ['kanbo_card_list { waitingForPerson }', 'kanbo_card_list', () => ({ waitingForPerson: true })],
        ['kanbo_card_list { column: in_progress }', 'kanbo_card_list', () => ({ column: 'in_progress' })],
        ['kanbo_card_list { detail: full }', 'kanbo_card_list', () => ({ detail: 'full' })],
        ['kanbo_card_get', 'kanbo_card_get', index => ({ card: String(cardNumber(index)) })],
        ['kanbo_card_get { include: all }', 'kanbo_card_get', index => ({ card: String(cardNumber(index)), include: ['comments', 'subCards', 'runs', 'history', 'prs'] })],
        ['kanbo_card_pull_requests', 'kanbo_card_pull_requests', index => ({ card: String(cardNumber(index)) })],
        ['kanbo_sprints', 'kanbo_sprints', () => ({})],
      ]
      for (const [label, name, input] of readTools) {
        record('mcp', label, await time(counter, iterations, async index => await tool(name, input(index))))
        if (payloadSizes.includes(size)) {
          const text = await tool(name, input(1))
          payloads.push({ engine, size, tool: label, chars: text.length, tokens: Math.round(text.length / 4) })
        }
      }
      record('mcp', 'kanbo_card_create', await time(counter, iterations, async index => await tool('kanbo_card_create', { title: `Agent card ${index}` })))
      record('mcp', 'kanbo_card_move', await time(counter, iterations, async index =>
        await tool('kanbo_card_move', { card: String(cardNumber(index)), column: index % 2 === 0 ? 'in_progress' : 'to_do' })))
    }
    finally {
      await client.close()
      await transport.close()
    }

    // `kanbo serve`, over HTTP on loopback.
    const running = await startKanboServer({
      session: { ops, store: board.store, workspace: SEED_WORKSPACE, assertWritable: async () => {} },
      actors: { writer: { kind: 'external', id: null }, person: null },
      host: '127.0.0.1',
      port: 0,
    })
    try {
      record('serve', 'GET /issues', await time(counter, iterations, async () => {
        const response = await fetch(`${running.url}/issues`)
        await response.json()
      }))
    }
    finally {
      await running.close()
    }

    // A spawned `kanbo`, the way a shell or an agent's Bash tool runs it: Node start-up included.
    if (spawnWanted && board.path) {
      const noCounter = createQueryCounter()
      const spawned = async (...words) => {
        const result = spawnSync(process.execPath, [CLI, ...words, ...board.target, '--json'], { encoding: 'utf8', env: process.env, maxBuffer: 1024 * 1024 * 1024 })
        if (result.status !== 0) {
          throw new Error(`kanbo ${words.join(' ')}: ${result.error?.message ?? result.stderr}`)
        }
      }
      for (const words of [['card', 'list'], ['ready'], ['card', 'get', '5'], ['board']]) {
        const result = await time(noCounter, spawnIterations, async () => await spawned(...words))
        record('cli (spawned)', words.join(' '), { ...result, statements: null })
      }
    }
  }
  finally {
    countQueriesOfNewBoardHandles(null)
    await board.dispose()
    process.chdir(cwd)
    rmSync(projectDir, { force: true, recursive: true })
  }
  return { rows, payloads, seedMs: board.seedMs }
}

// ---------------------------------------------------------------- report

if (spawnWanted && engines.includes('sqlite') && !existsSync(CLI)) {
  console.error('dist/cli.cjs is missing: run `npm run build` first, or pass --no-spawn.')
  process.exit(1)
}

const results = []
for (const engine of engines) {
  for (const size of sizes) {
    const started = performance.now()
    process.stderr.write(`bench: ${engine}, ${size} cards … `)
    results.push({ engine, size, ...await benchBoard(engine, size) })
    process.stderr.write(`${((performance.now() - started) / 1000).toFixed(1)} s\n`)
  }
}

const lines = [
  `# kanbo bench — ${new Date().toISOString().slice(0, 10)}`,
  '',
  `Machine: ${cpus()[0]?.model ?? 'unknown CPU'} × ${cpus().length}, ${Math.round(totalmem() / 2 ** 30)} GB, ${platform()} ${release()}, Node ${process.version}.`,
  `Samples: ${iterations} per operation (${spawnIterations} for a spawned CLI), after one warm-up. Times in ms.`,
  '',
  '## Seeding',
  '',
  '| engine | cards | seed time (s) |',
  '| --- | ---: | ---: |',
  ...results.map(result => `| ${result.engine} | ${result.size} | ${(result.seedMs / 1000).toFixed(1)} |`),
]

for (const engine of engines) {
  const mine = results.filter(result => result.engine === engine)
  const operations = [...new Map(mine.flatMap(result => result.rows).map(row => [`${row.surface}|${row.operation}`, row])).values()]
  lines.push('', `## Latency — ${engine}`, '', `p50 / p95 in ms; statements = what the last sample ran.`, '')
  lines.push(`| surface | operation | ${mine.map(result => `${result.size} cards`).join(' | ')} | statements |`)
  lines.push(`| --- | --- | ${mine.map(() => '---:').join(' | ')} | ---: |`)
  for (const { surface, operation } of operations) {
    const cells = mine.map((result) => {
      const row = result.rows.find(candidate => candidate.surface === surface && candidate.operation === operation)
      return row ? `${ms(row.p50)} / ${ms(row.p95)}` : '—'
    })
    const counts = [...new Set(mine.map(result => result.rows.find(row => row.surface === surface && row.operation === operation)?.statements)
      .filter(count => count !== null && count !== undefined))]
    lines.push(`| ${surface} | ${operation} | ${cells.join(' | ')} | ${counts.length > 0 ? counts.join(' / ') : '—'} |`)
  }
}

const payloads = results.flatMap(result => result.payloads)
if (payloads.length > 0) {
  const shown = [...new Set(payloads.map(payload => `${payload.engine}|${payload.size}`))]
  lines.push('', '## MCP response size', '', 'Characters of the tool\'s text answer, and tokens estimated as characters / 4.', '')
  lines.push(`| tool | ${shown.map(key => key.replace('|', ', ') + ' cards').join(' | ')} |`)
  lines.push(`| --- | ${shown.map(() => '---:').join(' | ')} |`)
  for (const tool of [...new Set(payloads.map(payload => payload.tool))]) {
    const cells = shown.map((key) => {
      const found = payloads.find(payload => `${payload.engine}|${payload.size}` === key && payload.tool === tool)
      return found ? `${found.chars.toLocaleString('en-US')} ch ≈ ${found.tokens.toLocaleString('en-US')} tok` : '—'
    })
    lines.push(`| ${tool} | ${cells.join(' | ')} |`)
  }
}

const report = `${lines.join('\n')}\n`
if (out) {
  writeFileSync(out, report)
}
process.stdout.write(report)

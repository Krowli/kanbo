import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PGlite } from '@electric-sql/pglite'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Command } from 'commander'
import { drizzle } from 'drizzle-orm/pglite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildCapabilitiesManifest } from '../capabilities/manifest'
import { createCliActor } from '../cli/actor'
import { registerKanboCommands } from '../cli/commands'
import { ROLES_NEED_A_DATABASE_MESSAGE } from '../cli/commands/roles'
import type { RunningServe } from '../cli/commands/serve'
import { startServe } from '../cli/commands/serve'
import { openMcpBoard } from '../cli/mcp-board'
import { overridePostgresOpenerForTests } from '../cli/postgres-board'
import { KANBO_CAPABILITIES_MARKDOWN_RESOURCE_URI, KANBO_CAPABILITIES_RESOURCE_URI } from '../mcp/resources'
import { createKanboMcpServer } from '../mcp/server'
import { APPROVED_COMMENT } from '../ops/approval'
import { migrateBoardDatabase } from '../postgres/migrate'
import { BOARD_AGENT_ROLE, BOARD_PERSON_ROLE } from '../postgres/roles.sql'
import { boardPostgresSchema } from '../postgres/schema'
import { writeFakeBin } from '../testing/fake-bin'

/**
 * The capability matrix: every command the `kanbo` binary answers to and every
 * tool `kanbo mcp` serves, driven against a real board — a board file of the
 * project's own and a Postgres board (PGlite) — and each result checked
 * through a different door than the one that wrote it. A card an agent creates
 * over MCP has to show up in `kanbo card list` and on `kanbo serve`'s
 * `/issues`; a move typed in the terminal has to reach the agent's
 * `kanbo_card_get` and the card's history; a person's approval has to reach
 * both. A door that writes something no other door can see is exactly the bug
 * each door's own tests cannot find.
 *
 * The doors are the ones the product opens, in this process:
 * - the terminal: `registerKanboCommands`, the binary's own program;
 * - MCP: `openMcpBoard` + `createKanboMcpServer` with the run tools — what
 *   `kanbo mcp` wires to stdio — over an in-memory link to an SDK client;
 * - HTTP: `startServe`, the body of `kanbo serve`, on a free port.
 *
 * The last test is the guard: it reads the capabilities manifest and fails when
 * a command or tool has no case here and no entry in `NOT_DRIVEN_HERE`.
 */

/** A command or tool that no case below drives in-process, and why that is fine. */
const NOT_DRIVEN_HERE: Record<string, string> = {
  'mcp': 'A stdio server, not a command that returns. Its body — openMcpBoard + createKanboMcpServer with the run '
    + 'tools — is the MCP door every case here calls through; the process itself is started from the `.mcp.json` '
    + '`connect` wrote and handshaken by `kanbo doctor` in the setup case, and by scripts/smoke.mjs on the installed package.',
}

/** This package's own command, run from source: the `kanbo` on the test's PATH. */
const CLI_ENTRY = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'index.ts')
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli')

/**
 * The folder the tests run from: doctor's handshake starts `kanbo mcp` through
 * cross-spawn, which changes into the project to look the command up. Windows
 * cannot remove a folder a process is in.
 */
const TEST_CWD = process.cwd()

/** A connection string shaped like a real one; the opener below hands over PGlite instead. */
const DATABASE_URL = 'postgres://person:secret@board.example:5432/board'

/** The bearer token every HTTP call presents. */
const SERVE_TOKEN = 'matrix-token'

type Engine = 'sqlite' | 'postgres'

/** One board, with the three doors onto it. */
interface MatrixBoard {
  engine: Engine
  projectDir: string
  /** Run `kanbo …` in this process; what it printed on stdout. `agent` runs it from an agent's shell. */
  cli: (argv: string[], as?: { agent?: boolean }) => Promise<string>
  /** The same, expected to fail: the exit code it failed with. */
  cliFails: (argv: string[], as?: { agent?: boolean }) => Promise<number>
  /** `kanbo …` with `--json`, parsed. */
  cliJson: <T = any>(argv: string[], as?: { agent?: boolean }) => Promise<T>
  /** One MCP tool call, as an agent's MCP client makes it; the answer parsed when it is JSON. */
  tool: <T = any>(name: string, args?: Record<string, unknown>) => Promise<T>
  /** The same, expected to be refused: the text it was refused with. */
  toolFails: (name: string, args?: Record<string, unknown>) => Promise<string>
  /** The MCP client itself, for resources and the handshake. */
  mcpClient: () => Promise<Client>
  /** One HTTP call to `kanbo serve`, with the token. */
  http: <T = any>(method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number, json: T }>
  /** The workspace id `kanbo serve` answers for — what a POST body names. */
  workspaceId: () => Promise<string>
  /** The Postgres board itself, on that engine. */
  pg: PGlite | null
}

interface MatrixCase {
  name: string
  /** The manifest entries this case drives: command paths (`card move`) and tool names. */
  covers: string[]
  /** The engines it runs on; both unless it says. */
  engines?: Engine[]
  run: (board: MatrixBoard) => Promise<void>
}

const CASES: MatrixCase[] = [
  {
    name: 'a card an agent creates over MCP is in the terminal\'s list, on the board and on /issues',
    covers: ['kanbo_card_create', 'card list', 'board'],
    run: async (b) => {
      const created = await b.tool('kanbo_card_create', { title: 'From the agent', description: 'Made over MCP', column: 'to_do' })
      expect(created).toEqual({ id: 'MAT-001', title: 'From the agent', column: 'to_do', updatedAt: expect.any(Number) })

      expect(await b.cliJson(['card', 'list', '--json', 'id,title,columnSlug'])).toEqual([
        { id: 'MAT-001', title: 'From the agent', columnSlug: 'to_do' },
      ])
      expect(await b.cliJson(['card', 'list', '--column', 'to_do', '--limit', '1', '--json', 'id'])).toEqual([{ id: 'MAT-001' }])
      expect(await b.cli(['board'])).toMatch(/To Do \(1\)[\s\S]*MAT-001 {2}From the agent/)
      const listed = await b.http<{ id: string, description: string }[]>('GET', '/issues')
      expect(listed.json.map(card => [card.id, card.description])).toEqual([['MAT-001', 'Made over MCP']])
    },
  },
  {
    name: 'a card typed in the terminal is what the agent\'s card_get and card_list read, and /issues/:id',
    covers: ['card create', 'card get', 'kanbo_card_get', 'kanbo_card_list'],
    run: async (b) => {
      await b.cli(['card', 'create', '--title', 'Parent', '--column', 'to_do', '--execution-mode', 'main'])
      await b.cli(['card', 'create', '--title', 'Child', '--parent', 'MAT-001', '--description', 'part of it', '--column', 'backlog'])

      const parent = await b.tool('kanbo_card_get', { card: 'MAT-1' })
      expect(parent).toMatchObject({ id: 'MAT-001', executionMode: 'main', columnSlug: 'to_do' })
      expect(parent.subCards).toEqual([{ id: 'MAT-002', title: 'Child', columnSlug: 'backlog' }])
      expect((await b.tool('kanbo_card_list', { column: 'backlog' })).cards.map((card: any) => card.id)).toEqual(['MAT-002'])
      expect((await b.cliJson(['card', 'get', '2', '--json', 'parentIssueId']))).toEqual({ parentIssueId: 'MAT-001' })
      expect((await b.http('GET', '/issues/MAT-002')).json).toMatchObject({ description: 'part of it', parentIssueId: 'MAT-001' })
    },
  },
  {
    name: 'one question, one call: the agent\'s card_list filters and card_get parts match the terminal\'s',
    covers: ['card list', 'card get', 'kanbo_card_list', 'kanbo_card_get'],
    run: async (b) => {
      await b.cli(['card', 'create', '--title', 'Parent', '--column', 'to_do'])
      await b.cli(['card', 'create', '--title', 'Parser fix', '--parent', 'MAT-001', '--column', 'in_progress'])
      await b.cli(['card', 'create', '--title', 'Needs a look', '--column', 'in_review'])
      await b.tool('kanbo_wait_approval', { card: 'MAT-003', text: 'check the diff' })
      await b.tool('kanbo_run_start', { card: 'MAT-002', agent: 'Claude' })
      await b.tool('kanbo_card_link_pr', { card: 'MAT-002', url: 'octo/repo#7' })
      await b.cli(['card', 'comment', 'MAT-002', '--content', 'found the cause'])
      const ids = (page: any): string[] => page.cards.map((card: any) => card.id)
      const cliIds = async (...argv: string[]): Promise<string[]> =>
        (await b.cliJson(['card', 'list', ...argv, '--json', 'id'])).map((card: any) => card.id)

      expect(ids(await b.tool('kanbo_card_list', { waitingForPerson: true }))).toEqual(['MAT-003'])
      expect(await cliIds('--waiting')).toEqual(['MAT-003'])
      expect(ids(await b.tool('kanbo_card_list', { hasActiveRun: true, parent: 'MAT-001' }))).toEqual(['MAT-002'])
      expect(await cliIds('--active', '--parent', 'MAT-001')).toEqual(['MAT-002'])
      expect(ids(await b.tool('kanbo_card_list', { text: 'parser', columns: ['in_progress', 'in_review'] }))).toEqual(['MAT-002'])
      expect(await cliIds('--text', 'parser', '--column', 'in_progress,in_review')).toEqual(['MAT-002'])
      expect(ids(await b.tool('kanbo_card_list', { updatedSince: '2000-01-01', limit: 2 }))).toEqual(['MAT-001', 'MAT-002'])
      expect(await cliIds('--updated-since', '2000-01-01', '--limit', '2')).toEqual(['MAT-001', 'MAT-002'])

      const everything = ['comments', 'subCards', 'runs', 'history', 'prs']
      const read = await b.tool('kanbo_card_get', { card: 'MAT-002', include: everything })
      expect(read.runs).toEqual([expect.objectContaining({ agentName: 'Claude', state: 'running' })])
      expect(read.pullRequests).toEqual([expect.objectContaining({ owner: 'octo', repo: 'repo', number: 7 })])
      expect(read.comments.at(-1)).toMatchObject({ content: 'found the cause' })
      const printed = await b.cliJson(['card', 'get', 'MAT-002', '--include', everything.join(','), '--json', 'comments,history,commentCount'])
      expect(printed).toEqual({ comments: read.comments, history: read.history, commentCount: read.commentCount })
      expect((await b.tool('kanbo_card_get', { card: 'MAT-001' })).subCards).toEqual([{ id: 'MAT-002', title: 'Parser fix', columnSlug: 'in_progress' }])
    },
  },
  {
    name: 'a move in the terminal reaches the agent and the card\'s history; the agent\'s move reaches the terminal',
    covers: ['card move', 'kanbo_card_move'],
    run: async (b) => {
      await b.cli(['card', 'create', '--title', 'Moving', '--column', 'to_do'])

      await b.cli(['card', 'move', 'MAT-001', 'in_progress'])
      expect(await b.tool('kanbo_card_get', { card: 'MAT-001' })).toMatchObject({ column: 'In Progress', columnSlug: 'in_progress' })
      const inProgress = (await b.tool('kanbo_columns')).find((column: any) => column.slug === 'in_progress')
      const history = await b.http<{ field: string, toValue: string }[]>('GET', '/issues/MAT-001/field-changes')
      expect(history.json).toContainEqual(expect.objectContaining({ field: 'statusId', toValue: inProgress.id }))

      await b.tool('kanbo_card_move', { card: 'MAT-001', column: 'in_review' })
      expect(await b.cliJson(['card', 'get', 'MAT-001', '--json', 'columnSlug'])).toEqual({ columnSlug: 'in_review' })
    },
  },
  {
    name: 'an update from either side is read by the other, and lands in the history',
    covers: ['card update', 'kanbo_card_update'],
    run: async (b) => {
      await b.cli(['card', 'create', '--title', 'Before'])

      await b.cli(['card', 'update', 'MAT-001', '--title', 'After', '--priority', 'high', '--labels', 'ui,bug'])
      expect(await b.tool('kanbo_card_get', { card: 'MAT-001' })).toMatchObject({ title: 'After', priority: 'high', labels: ['ui', 'bug'] })

      await b.tool('kanbo_card_update', { card: 'MAT-001', description: 'Written by the agent', executionMode: 'main' })
      expect(await b.cliJson(['card', 'get', 'MAT-001', '--json', 'description,executionMode']))
        .toEqual({ description: 'Written by the agent', executionMode: 'main' })
      const history = JSON.stringify((await b.http('GET', '/issues/MAT-001/field-changes')).json)
      expect(history).toContain('After')
      expect(history).toContain('Written by the agent')
    },
  },
  {
    name: 'a status line set over MCP is on `kanbo board`; one set in the terminal is on the agent\'s card',
    covers: ['kanbo_status_line', 'card status-line'],
    run: async (b) => {
      await b.cli(['card', 'create', '--title', 'Busy', '--column', 'in_progress'])

      await b.tool('kanbo_status_line', { card: 'MAT-001', text: 'running the tests' })
      expect(await b.cli(['board'])).toMatch(/MAT-001 {2}Busy[\s\S]*running the tests/)

      await b.cli(['card', 'status-line', 'MAT-001', '--text', 'tests pass'], { agent: true })
      expect(await b.tool('kanbo_card_get', { card: 'MAT-001' })).toMatchObject({ statusLine: 'tests pass' })
      expect((await b.http('GET', '/issues/MAT-001')).json).toMatchObject({ statusLine: 'tests pass' })
    },
  },
  {
    name: 'comments from the agent and from the terminal are both on /issues/:id/comments',
    covers: ['kanbo_card_comment', 'card comment'],
    run: async (b) => {
      await b.cli(['card', 'create', '--title', 'Talk'])

      await b.tool('kanbo_card_comment', { card: 'MAT-001', content: 'A finding from the agent' })
      await b.cli(['card', 'comment', 'MAT-001', '--content', 'A note from the terminal'])

      const comments = await b.http<{ content: string }[]>('GET', '/issues/MAT-001/comments')
      expect(comments.json.map(comment => comment.content)).toEqual(['A finding from the agent', 'A note from the terminal'])
    },
  },
  {
    name: 'the agent asks over MCP, a person approves in the terminal, and the agent sees it approved',
    covers: ['kanbo_wait_approval', 'approve'],
    run: async (b) => {
      await b.cli(['card', 'create', '--title', 'Ship it', '--column', 'in_review'])

      await b.tool('kanbo_wait_approval', { card: 'MAT-001', text: 'ready to merge' })
      expect(await b.cliJson(['card', 'get', 'MAT-001', '--json', 'waitingFor,statusLine']))
        .toEqual({ waitingFor: 'human', statusLine: 'ready to merge' })

      // An agent's shell is refused, and the card stays waiting.
      expect(await b.cliFails(['approve', 'MAT-001'], { agent: true })).toBe(4)
      expect(await b.tool('kanbo_card_get', { card: 'MAT-001' })).toMatchObject({ waitingFor: 'human' })

      await b.cli(['approve', 'MAT-001', '--comment', 'Looks right'])
      expect(await b.tool('kanbo_card_get', { card: 'MAT-001' })).toMatchObject({ waitingFor: null })
      const comments = (await b.http<{ content: string }[]>('GET', '/issues/MAT-001/comments')).json.map(comment => comment.content)
      expect(comments.join('\n')).toContain(APPROVED_COMMENT)
      expect(comments.join('\n')).toContain('Looks right')
    },
  },
  {
    name: 'the terminal\'s wait-approval and return reach the agent\'s card',
    covers: ['card wait-approval', 'return'],
    run: async (b) => {
      await b.cli(['card', 'create', '--title', 'Check me', '--column', 'in_review'])

      await b.cli(['card', 'wait-approval', 'MAT-001', '--text', 'please look'], { agent: true })
      expect((await b.http('GET', '/issues/MAT-001')).json).toMatchObject({ waitingFor: 'human', statusLine: 'please look' })

      expect(await b.cliFails(['return', 'MAT-001', '--comment', 'no'], { agent: true })).toBe(4)
      await b.cli(['return', 'MAT-001', '--comment', 'Needs a test', '--to', 'in_progress'])
      expect(await b.tool('kanbo_card_get', { card: 'MAT-001' })).toMatchObject({ waitingFor: null, columnSlug: 'in_progress' })
      const comments = (await b.http<{ content: string }[]>('GET', '/issues/MAT-001/comments')).json
      expect(comments.map(comment => comment.content).join('\n')).toContain('Needs a test')
    },
  },
  {
    name: 'runs: started, attached, cleared and finished from either side, read by the others',
    covers: ['kanbo_run_start', 'kanbo_run_finish', 'run start', 'run attach-session', 'run clear-session', 'run finish'],
    run: async (b) => {
      await b.cli(['card', 'create', '--title', 'Work', '--column', 'in_progress'])

      const run = await b.tool('kanbo_run_start', { card: 'MAT-001', agent: 'Claude', branch: 'feat/x' })
      expect(await b.cliJson(['card', 'get', 'MAT-001', '--json', 'activeRun'])).toMatchObject({
        activeRun: { id: run.id, agentName: 'Claude', state: 'running' },
      })
      const started = (await b.http<{ id: string, branch: string | null }[]>('GET', '/issues/MAT-001/runs')).json
      expect(started.find(entry => entry.id === run.id)?.branch).toBe('feat/x')

      await b.cli(['run', 'attach-session', run.id, 'claude:session-1'], { agent: true })
      const attached = (await b.http<{ id: string, externalSessionRef: string | null }[]>('GET', '/issues/MAT-001/runs')).json
      expect(attached.find(entry => entry.id === run.id)?.externalSessionRef).toBe('claude:session-1')

      expect(await b.cliFails(['run', 'clear-session', run.id], { agent: true })).toBe(4)
      await b.cli(['run', 'clear-session', run.id])
      const cleared = (await b.http<{ id: string, externalSessionRef: string | null }[]>('GET', '/issues/MAT-001/runs')).json
      expect(cleared.find(entry => entry.id === run.id)?.externalSessionRef).toBeNull()

      await b.cli(['run', 'finish', run.id, '--state', 'finished'], { agent: true })
      expect(await b.tool('kanbo_card_get', { card: 'MAT-001' })).toMatchObject({ activeRun: null, attemptCount: 1 })

      const second = await b.cliJson(['run', 'start', 'MAT-001', '--agent', 'Codex', '--session', 'codex:abc', '--json'], { agent: true })
      await b.tool('kanbo_run_finish', { run: second.id, state: 'failed', errorText: 'tests broke' })
      const runs = (await b.http<{ id: string, state: string, externalSessionRef: string | null }[]>('GET', '/issues/MAT-001/runs')).json
      expect(runs.find(entry => entry.id === second.id)).toMatchObject({ state: 'failed', externalSessionRef: 'codex:abc' })
      const comments = (await b.http<{ content: string }[]>('GET', '/issues/MAT-001/comments')).json.map(comment => comment.content)
      expect(comments.join('\n')).toContain('tests broke')
    },
  },
  {
    name: 'pull request links from either side are listed by the other; a removal reaches /pull-requests',
    covers: ['kanbo_card_link_pr', 'kanbo_card_pull_requests', 'card pr add', 'card pr list', 'card pr remove'],
    run: async (b) => {
      await b.cli(['card', 'create', '--title', 'PR'])

      await b.tool('kanbo_card_link_pr', { card: 'MAT-001', url: 'octo/repo#7' })
      expect((await b.cliJson(['card', 'pr', 'list', 'MAT-001', '--json'])).map((link: any) => link.url))
        .toEqual(['https://github.com/octo/repo/pull/7'])

      const added = await b.cliJson(['card', 'pr', 'add', 'MAT-001', 'https://github.com/octo/repo/pull/8', '--json'])
      expect((await b.tool('kanbo_card_pull_requests', { card: 'MAT-001' })).map((link: any) => link.number)).toEqual([7, 8])

      await b.cli(['card', 'pr', 'remove', 'MAT-001', added.id])
      const left = (await b.http<{ number: number }[]>('GET', '/issues/MAT-001/pull-requests')).json
      expect(left.map(link => link.number)).toEqual([7])
    },
  },
  {
    name: 'sprints: created in the terminal, read by the agent and /issues/sprints, closed only by a person',
    covers: ['sprint create', 'sprint list', 'sprint close', 'kanbo_sprints'],
    run: async (b) => {
      const sprint = await b.cliJson(['sprint', 'create', '--title', 'Sprint 1', '--start', '2026-09-01', '--due', '2026-09-14', '--json'])

      expect((await b.tool('kanbo_sprints')).map((entry: any) => [entry.title, entry.status])).toEqual([['Sprint 1', 'open']])
      expect((await b.cliJson(['sprint', 'list', '--json'])).map((entry: any) => entry.id)).toEqual([sprint.id])
      expect((await b.http<{ id: string }[]>('GET', `/issues/sprints?workspaceId=${await b.workspaceId()}`)).json.map(entry => entry.id)).toEqual([sprint.id])

      expect(await b.cliFails(['sprint', 'close', sprint.id], { agent: true })).toBe(4)
      expect((await b.tool('kanbo_sprints'))[0].status).toBe('open')
      await b.cli(['sprint', 'close', sprint.id])
      expect((await b.tool('kanbo_sprints'))[0].status).toBe('closed')
    },
  },
  {
    name: 'columns: a person changes them in the terminal, the agent reads every change, an agent\'s shell is refused',
    covers: [
      'columns list',
      'columns describe',
      'columns rules',
      'columns add',
      'columns rename',
      'columns move',
      'columns remove',
      'columns template',
      'columns add-standard',
      'kanbo_columns',
    ],
    run: async (b) => {
      const slugs = async (): Promise<string[]> => (await b.tool('kanbo_columns')).map((column: any) => column.slug)
      const before = await slugs()
      expect((await b.cliJson(['columns', 'list', '--json'])).map((column: any) => column.slug)).toEqual(before)

      // Every structural change is refused in an agent's shell, and nothing moves.
      for (const argv of [
        ['columns', 'add', 'QA'],
        ['columns', 'rename', 'in_review', 'Review'],
        ['columns', 'move', 'backlog', '--last'],
        ['columns', 'remove', 'backlog'],
        ['columns', 'template', 'standard', '--add-missing'],
        ['columns', 'add-standard'],
        ['columns', 'rules', 'done', '--require', 'pull_request_linked'],
      ]) {
        expect(await b.cliFails(argv, { agent: true })).toBe(4)
      }
      expect(await slugs()).toEqual(before)

      await b.cli(['columns', 'add', 'QA', '--after', 'in_review', '--description', 'Tested by hand'])
      expect(await slugs()).toEqual(['backlog', 'to_do', 'in_progress', 'in_review', 'qa', 'done', 'canceled'])
      await b.cli(['columns', 'rename', 'qa', 'Testing'])
      await b.cli(['columns', 'move', 'testing', '--first'])
      expect(await slugs()).toEqual(['testing', 'backlog', 'to_do', 'in_progress', 'in_review', 'done', 'canceled'])
      await b.cli(['columns', 'describe', 'testing', '--text', 'A person clicks through it'])
      await b.cli(['columns', 'rules', 'testing', '--require', 'pull_request_linked'])
      expect((await b.tool('kanbo_columns'))[0]).toMatchObject({
        name: 'Testing',
        description: 'A person clicks through it',
        entryRules: ['pull_request_linked'],
      })

      await b.cli(['columns', 'remove', 'testing'])
      await b.cli(['columns', 'remove', 'canceled'])
      expect(await slugs()).toEqual(['backlog', 'to_do', 'in_progress', 'in_review', 'done'])
      await b.cli(['columns', 'template', 'standard', '--add-missing'])
      expect(await slugs()).toContain('canceled')
      await b.cli(['columns', 'remove', 'canceled'])
      await b.cli(['columns', 'add-standard'])
      expect(await slugs()).toEqual(before)
    },
  },
  {
    name: 'a card a person returns in the terminal comes first for the agent: card_list returned, ready, prime and the terminal\'s list',
    covers: ['card list', 'return', 'kanbo_card_list', 'kanbo_ready', 'kanbo_prime'],
    run: async (b) => {
      await b.cli(['card', 'create', '--title', 'Check me', '--column', 'in_review'])
      await b.tool('kanbo_card_comment', { id: 'MAT-001', text: 'Done, please look' })
      await b.tool('kanbo_wait_approval', { card: 'MAT-001', content: 'please look' })
      // What is waiting says what it asks, in the one list call.
      expect((await b.tool('kanbo_card_list', { waitingForPerson: true })).cards).toEqual([
        expect.objectContaining({ id: 'MAT-001', lastComment: expect.objectContaining({ text: 'Done, please look' }) }),
      ])

      await b.cli(['return', 'MAT-001', '--comment', 'Needs a test'])
      const returned = { id: 'MAT-001', returned: true, lastComment: expect.objectContaining({ author: 'user', text: 'Needs a test' }) }
      expect((await b.tool('kanbo_card_list', { returned: true })).cards).toEqual([expect.objectContaining(returned)])
      expect((await b.tool('kanbo_ready')).returned).toEqual([expect.objectContaining(returned)])
      expect(await b.tool<string>('kanbo_prime')).toMatch(/^Returned to you[^\n]*\n\n- MAT-001 Check me \(`in_progress`\) — person: "Needs a test"/)
      expect(await b.cliJson(['card', 'list', '--returned', '--json', 'id,returned'])).toEqual([{ id: 'MAT-001', returned: true }])
      expect(await b.cli(['ready'], { agent: true })).toContain('Returned to you')
      expect((await b.tool('kanbo_card_get', { card: 'MAT-001', include: [] })).statusLine).toBe('returned by a person: Needs a test')
    },
  },
  {
    name: 'ready and prime read the same board from the terminal, over MCP and over HTTP',
    covers: ['ready', 'prime', 'kanbo_ready', 'kanbo_prime'],
    run: async (b) => {
      await b.tool('kanbo_card_create', { title: 'Next up', column: 'to_do' })
      await b.cli(['card', 'create', '--title', 'Later', '--column', 'to_do'])

      expect((await b.cliJson(['ready', '--json'])).map((card: any) => card.id)).toEqual(['MAT-001', 'MAT-002'])
      expect(await b.tool('kanbo_ready', { limit: 1 })).toEqual({
        total: 2,
        more: 1,
        nextOffset: 1,
        cards: [{ id: 'MAT-001', title: 'Next up', column: 'to_do', updatedAt: expect.any(Number) }],
      })
      expect((await b.http<{ id: string }[]>('GET', `/issues/ready?workspaceId=${await b.workspaceId()}`)).json.map(card => card.id)).toEqual(['MAT-001', 'MAT-002'])

      const primed = await b.tool<string>('kanbo_prime')
      expect(primed).toContain('To Do (`to_do`)')
      // The terminal's prime is the board's own text, plus a cheat sheet of commands.
      const printed = await b.cli(['prime'])
      expect(printed.startsWith(primed.trimEnd())).toBe(true)
      expect(printed).toContain('kanbo ready')
    },
  },
  {
    name: 'capabilities: the terminal prints the manifest MCP serves as resources',
    covers: ['capabilities'],
    run: async (b) => {
      const client = await b.mcpClient()
      const served = await client.readResource({ uri: KANBO_CAPABILITIES_RESOURCE_URI })
      const servedMarkdown = await client.readResource({ uri: KANBO_CAPABILITIES_MARKDOWN_RESOURCE_URI })

      expect(await b.cliJson(['capabilities', '--json'])).toEqual(JSON.parse(String((served.contents[0] as { text: string }).text)))
      expect(await b.cli(['capabilities', '--markdown'])).toBe(String((servedMarkdown.contents[0] as { text: string }).text))
    },
  },
  {
    name: 'setup: init, connect, instructions, doctor and uninstall on a project, checked through the files and each other',
    covers: ['init', 'connect', 'instructions', 'doctor', 'uninstall'],
    // These are about the project's own files, not the engine; and doctor's handshake starts a real
    // `kanbo mcp` process, which cannot reach the PGlite this process holds. `init` of a Postgres
    // board is every Postgres case's own setup.
    engines: ['sqlite'],
    run: async (b) => {
      // `init` made this board (beforeEach); the binding it wrote is what every other door found it by.
      expect(existsSync(join(b.projectDir, '.kanbo', 'binding.json'))).toBe(true)

      await b.cli(['connect', 'claude', '--project', '--yes'])
      const mcp = JSON.parse(readFileSync(join(b.projectDir, '.mcp.json'), 'utf8'))
      expect(mcp.mcpServers.kanbo.args).toContain('mcp')
      const block = await b.cli(['instructions', 'short'])
      expect(readFileSync(join(b.projectDir, 'CLAUDE.md'), 'utf8')).toContain(block.trim())
      expect(await b.cli(['connect', '--check'])).toMatch(/claude/i)

      const { findings } = await b.cliJson<{ findings: { check: string, status: string, detail: string }[] }>(['doctor', '--json'])
      expect(findings.filter(finding => finding.status === 'fail')).toEqual([])
      expect(findings).toContainEqual(expect.objectContaining({ check: 'instructions', status: 'ok' }))
      expect(findings).toContainEqual(expect.objectContaining({ check: 'mcp:claude', status: 'ok' }))
      expect(findings).toContainEqual(expect.objectContaining({ check: 'mcp:handshake', status: 'ok' }))

      await b.cli(['uninstall', '--project', '--yes'])
      expect(existsSync(join(b.projectDir, '.mcp.json'))
        ? JSON.parse(readFileSync(join(b.projectDir, '.mcp.json'), 'utf8')).mcpServers?.kanbo
        : undefined).toBeUndefined()
      const claudeMd = join(b.projectDir, 'CLAUDE.md')
      expect(existsSync(claudeMd) ? readFileSync(claudeMd, 'utf8') : '').not.toContain(block.trim())
    },
  },
  {
    name: 'migrate and roles: the schema the board is on, and the two roles where a database has them',
    covers: ['migrate', 'roles print', 'roles apply'],
    run: async (b) => {
      await b.tool('kanbo_card_create', { title: 'Survives a migration' })
      await b.cli(['migrate'])
      expect((await b.cliJson(['card', 'list', '--json', 'title']))).toEqual([{ title: 'Survives a migration' }])

      const sql = await b.cli(['roles', 'print'])
      expect(sql).toContain(BOARD_AGENT_ROLE)
      expect(sql).toContain(BOARD_PERSON_ROLE)

      if (b.pg) {
        await b.cli(['roles', 'apply'])
        const roles = await b.pg.query<{ rolname: string }>(
          'select rolname from pg_roles where rolname in ($1, $2) order by rolname',
          [BOARD_AGENT_ROLE, BOARD_PERSON_ROLE],
        )
        expect(roles.rows.map(row => row.rolname)).toEqual([BOARD_AGENT_ROLE, BOARD_PERSON_ROLE].sort())
      }
      else {
        await expect(b.cli(['roles', 'apply'])).rejects.toThrowError(ROLES_NEED_A_DATABASE_MESSAGE)
      }
    },
  },
  {
    name: 'serve: card create, read, update and delete over HTTP, read back by MCP and the terminal',
    covers: ['serve'],
    run: async (b) => {
      const workspaceId = await b.workspaceId()
      const created = await b.http('POST', '/issues', { workspaceId, title: 'Over HTTP', statusName: 'to_do' })
      expect(created.status).toBe(200)
      expect(await b.tool('kanbo_card_get', { card: created.json.id })).toMatchObject({ title: 'Over HTTP', columnSlug: 'to_do' })

      expect((await b.http('PATCH', `/issues/${created.json.id}`, { title: 'Renamed over HTTP' })).status).toBe(200)
      expect(await b.cliJson(['card', 'get', created.json.id, '--json', 'title'])).toEqual({ title: 'Renamed over HTTP' })

      expect((await b.http('PATCH', `/issues/${created.json.id}/status/in_progress`)).status).toBe(200)
      expect(await b.tool('kanbo_card_get', { card: created.json.id })).toMatchObject({ columnSlug: 'in_progress' })

      // An agent may not delete a card, even with the token; a person may.
      expect((await b.http('DELETE', `/issues/${created.json.id}`, undefined, { 'x-kanbo-actor': 'agent' })).status).toBe(403)
      expect((await b.http('DELETE', `/issues/${created.json.id}`)).status).toBe(200)
      expect(await b.cliJson(['card', 'list', '--json', 'id'])).toEqual([])
      expect(await b.toolFails('kanbo_card_get', { card: created.json.id })).toMatch(/No card/i)
    },
  },
]

/** A Postgres with nothing in it — what a connection string names before `kanbo init --migrate`. */
async function createEmptyPostgres(): Promise<PGlite> {
  return await PGlite.create()
}

describe.each<Engine>(['sqlite', 'postgres'])('the capability matrix on a %s board', (engine) => {
  let root: string
  let projectDir: string
  let pg: PGlite | null
  let stdout: string[]
  let mcp: { client: Client, close: () => Promise<void> } | null
  let served: { running: RunningServe, url: string, workspaceId: string } | null

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), `kanbo-matrix-${engine}-`))
    const home = join(root, 'home')
    const bin = join(root, 'bin')
    projectDir = join(root, 'project')
    for (const directory of [home, bin, projectDir]) {
      mkdirSync(directory, { recursive: true })
    }
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    vi.stubEnv('CODEX_HOME', join(root, 'codex-home'))
    // No agent program is on this PATH — `connect claude` writes `.mcp.json` rather than asking
    // `claude` — only node, and a `kanbo` that is this package run from source.
    vi.stubEnv('PATH', [bin, dirname(process.execPath)].join(delimiter))
    writeFakeBin(bin, 'kanbo', [
      `const result = require('node:child_process').spawnSync(`,
      `  ${JSON.stringify(process.execPath)},`,
      `  [${JSON.stringify(TSX_CLI)}, ${JSON.stringify(CLI_ENTRY)}, ...process.argv.slice(2)],`,
      `  { stdio: 'inherit' },`,
      `)`,
      `process.exit(result.status ?? 1)`,
    ].join('\n'))
    for (const name of [
      'CLAUDE_CONFIG_DIR',
      'GEMINI_CLI_HOME',
      'LOCALAPPDATA',
      'KANBO_ACTOR_KIND',
      'KANBO_DB_PATH',
      'KANBO_DATABASE_URL',
      'KANBO_WORKSPACE_ID',
      'KANBO_SERVE_TOKEN',
    ]) {
      vi.stubEnv(name, undefined)
    }
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir)
    stdout = []
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      stdout.push(String(line))
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mcp = null
    served = null
    pg = null

    if (engine === 'sqlite') {
      await runCli(['init', '--file', '--yes', '--key', 'MAT', '--columns', 'standard'])
    }
    else {
      const database = await createEmptyPostgres()
      pg = database
      const drizzled = drizzle(database, { schema: boardPostgresSchema })
      overridePostgresOpenerForTests(async () => ({
        database: drizzled,
        migrate: async () => await migrateBoardDatabase(drizzled),
        runScript: async (script: string) => {
          await database.exec(script)
        },
        close: async () => {},
      }))
      await runCli(['init', '--yes', '--database-url', DATABASE_URL, '--workspace', 'matrix', '--key', 'MAT', '--migrate', '--columns', 'standard'])
    }
  })

  afterEach(async () => {
    await mcp?.close()
    await served?.running.close()
    overridePostgresOpenerForTests(null)
    await pg?.close()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    process.chdir(TEST_CWD)
    rmSync(root, { force: true, recursive: true })
  })

  async function runCli(argv: string[], as: { agent?: boolean } = {}): Promise<string> {
    stdout = []
    if (as.agent) {
      vi.stubEnv('KANBO_ACTOR_KIND', 'agent')
    }
    try {
      const program = new Command().exitOverride()
      registerKanboCommands(program)
      await program.parseAsync(argv, { from: 'user' })
      return stdout.join('\n')
    }
    finally {
      if (as.agent) {
        vi.stubEnv('KANBO_ACTOR_KIND', undefined)
      }
    }
  }

  async function openMcp(): Promise<Client> {
    if (mcp) {
      return mcp.client
    }
    // `kanbo mcp` from an agent's shell: every write is filed under that shell.
    vi.stubEnv('KANBO_ACTOR_KIND', 'agent')
    const board = await openMcpBoard({ actor: createCliActor() })
    vi.stubEnv('KANBO_ACTOR_KIND', undefined)
    const server = createKanboMcpServer(board, { includeRunTools: true })
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await server.connect(serverSide)
    const client = new Client({ name: 'matrix', version: '1.0.0' })
    await client.connect(clientSide)
    mcp = {
      client,
      close: async () => {
        await client.close()
        await board.close()
      },
    }
    return client
  }

  async function callTool(name: string, args: Record<string, unknown>): Promise<{ text: string, isError: boolean }> {
    const client = await openMcp()
    const result = await client.callTool({ name, arguments: args })
    const content = result.content as { type: string, text: string }[]
    return { text: content[0]?.text ?? '', isError: result.isError === true }
  }

  async function serve(): Promise<NonNullable<typeof served>> {
    if (served) {
      return served
    }
    const status: string[] = []
    const running = await startServe(
      { port: '0', host: '127.0.0.1', token: SERVE_TOKEN, corsOrigin: [], open: false },
      { status: line => status.push(line), page: () => {} },
    )
    const match = /kanbo serve: (http:\/\/\S+) — workspace (\S+),/.exec(status[0] ?? '')
    if (!match) {
      throw new Error(`kanbo serve said: ${status.join('\n')}`)
    }
    served = { running, url: match[1]!, workspaceId: match[2]! }
    return served
  }

  const board: MatrixBoard = {
    engine,
    get projectDir() {
      return projectDir
    },
    get pg() {
      return pg
    },
    cli: runCli,
    cliFails: async (argv, as) => {
      try {
        await runCli(argv, as)
      }
      catch (error) {
        return (error as { exitCode: number }).exitCode
      }
      throw new Error(`kanbo ${argv.join(' ')} did not fail`)
    },
    cliJson: async (argv, as) => {
      const withJson = argv.some(word => word === '--json') ? argv : [...argv, '--json']
      return JSON.parse(await runCli(withJson, as))
    },
    tool: async (name, args = {}) => {
      const { text, isError } = await callTool(name, args)
      if (isError) {
        throw new Error(`${name} was refused: ${text}`)
      }
      try {
        return JSON.parse(text)
      }
      catch {
        return text as never
      }
    },
    toolFails: async (name, args = {}) => {
      const { text, isError } = await callTool(name, args)
      if (!isError) {
        throw new Error(`${name} was not refused: ${text}`)
      }
      return text
    },
    mcpClient: openMcp,
    http: async (method, path, body, headers = {}) => {
      const { url } = await serve()
      const response = await fetch(`${url}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${SERVE_TOKEN}`,
          ...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const text = await response.text()
      return { status: response.status, json: text ? JSON.parse(text) : null }
    },
    workspaceId: async () => (await serve()).workspaceId,
  }

  for (const matrixCase of CASES.filter(entry => !entry.engines || entry.engines.includes(engine))) {
    it(matrixCase.name, async () => {
      await matrixCase.run(board)
    })
  }
})

describe('the capability matrix itself', () => {
  it('drives every command and tool the capabilities manifest lists, or says why not', () => {
    const manifest = buildCapabilitiesManifest()
    const listed = [...manifest.commands.map(command => command.path), ...manifest.tools.map(tool => tool.name)].sort()
    const covered = CASES.flatMap(matrixCase => matrixCase.covers)

    const missing = listed.filter(entry => !covered.includes(entry) && !(entry in NOT_DRIVEN_HERE))
    expect(missing, 'commands or tools with no matrix case').toEqual([])
    const unknown = [...covered, ...Object.keys(NOT_DRIVEN_HERE)].filter(entry => !listed.includes(entry))
    expect(unknown, 'matrix entries the manifest no longer lists').toEqual([])
    const both = covered.filter(entry => entry in NOT_DRIVEN_HERE)
    expect(both, 'entries both driven and excused').toEqual([])
  })
})

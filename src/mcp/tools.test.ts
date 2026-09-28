import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { BoardWorkspaceIdentity } from '../domain/numbering'
import { createBoardOps } from '../ops'
import type { BoardActor } from '../ops/types'
import { toCardView, toCardViews } from '../serve/views'
import { createSqliteBoardStore } from '../sqlite/board-store.sqlite'
import type { Issue, IssueRun } from '../sqlite/schema'
import type { TestBoardDatabase } from '../testing/board-database'
import { createTestBoardDatabase, seedHostWorkspace } from '../testing/board-database'
import type { KanboDbTransport } from './db-transport'
import { createDbTransport } from './db-transport'
import { createHttpTransport } from './http-transport'
import { createKanboMcpServer } from './server'
import type { KanboToolName } from './tool-names'
import { KANBO_TOOL_NAMES } from './tool-names'
import { KANBO_TOOLS } from './tools'
import type { KanboCardResult, KanboToolTransport } from './transport'

const WORKSPACE: BoardWorkspaceIdentity = { id: 'workspace', identifier: 'WOR', name: 'Workspace' }
const EXTERNAL: BoardActor = { kind: 'external', id: 'tester' }

/** The one operation each tool performs, and an input that reaches it. */
const TOOL_OPERATIONS: Record<KanboToolName, { op: keyof KanboToolTransport, input: Record<string, unknown> }> = {
  kanbo_prime: { op: 'prime', input: {} },
  kanbo_ready: { op: 'readyPage', input: {} },
  kanbo_columns: { op: 'columns', input: {} },
  kanbo_sprints: { op: 'sprints', input: {} },
  kanbo_card_get: { op: 'cardGet', input: { card: 'WOR-001' } },
  kanbo_card_list: { op: 'cardPage', input: {} },
  kanbo_card_create: { op: 'cardCreate', input: { title: 'A card' } },
  kanbo_card_update: { op: 'cardUpdate', input: { card: 'WOR-001', title: 'Renamed' } },
  kanbo_card_move: { op: 'cardMove', input: { card: 'WOR-001', column: 'in_progress' } },
  kanbo_card_comment: { op: 'cardComment', input: { card: 'WOR-001', content: 'A finding' } },
  kanbo_card_link_pr: { op: 'cardLinkPullRequest', input: { card: 'WOR-001', url: 'octo/repo#7' } },
  kanbo_card_pull_requests: { op: 'cardPullRequests', input: { card: 'WOR-001' } },
  kanbo_status_line: { op: 'statusLine', input: { card: 'WOR-001', text: 'reading the board' } },
  kanbo_wait_approval: { op: 'waitApproval', input: { card: 'WOR-001' } },
  kanbo_run_start: { op: 'runStart', input: { card: 'WOR-001', agent: 'Claude' } },
  kanbo_run_finish: { op: 'runFinish', input: { run: 'run-1', state: 'finished' } },
}

/**
 * The card as an app serving the `/issues` routes answers with one: the row, plus
 * what the run registry says about it — including the two ids only the host
 * that launched the run has any use for.
 */
function serverCardShape(card: Issue, run: IssueRun) {
  return {
    id: card.id,
    number: card.number,
    title: card.title,
    description: card.description,
    statusId: card.statusId,
    statusLine: card.statusLine,
    waitingFor: card.waitingFor,
    priority: card.priority,
    labels: [],
    executionMode: card.executionMode,
    parentIssueId: card.parentIssueId,
    updatedAt: card.updatedAt,
    attemptCount: 1,
    activeRun: {
      id: run.id,
      agentId: run.agentId,
      agentName: run.agentName,
      state: run.state,
      branch: run.branch,
      executionMode: run.executionMode,
      chatSessionId: run.chatSessionId,
      startedAt: run.startedAt,
    },
  }
}

/**
 * A transport that performs nothing and remembers what it was asked for. Every
 * operation answers the same stand-in, which is enough for a tool that only
 * hands its answer on — `kanbo_prime` reads `text` off it, the rest print it.
 */
function recordingTransport(): { transport: KanboToolTransport, calls: string[] } {
  const calls: string[] = []
  const operations = new Set(Object.values(TOOL_OPERATIONS).map(entry => entry.op))
  const transport = Object.fromEntries(Array.from(operations, op => [op, async () => {
    calls.push(op)
    // A list tool prints a page of cards; one card called "the board" is enough of one.
    return op.endsWith('Page')
      ? { cards: [{ id: 'WOR-001', title: 'the board', columnSlug: null, attemptCount: 0, activeRun: null, updatedAt: 0 }], total: 1, offset: 0 }
      : { text: 'the board' }
  }])) as unknown as KanboToolTransport
  return { transport, calls }
}

describe('the board\'s tools', () => {
  it('registers every name the board declares, and nothing else', () => {
    expect(KANBO_TOOLS.map(tool => tool.name)).toEqual([...KANBO_TOOL_NAMES])
  })

  it('has no tool that approves a card', () => {
    // Approval is a person's, and a tool an agent holds is not one. A name
    // carrying "approve" would be found by a model looking for a way out of
    // waiting — `kanbo_wait_approval` asks for one, which is the opposite.
    const approving = KANBO_TOOLS.filter(tool => /approve/.test(tool.name) && tool.name !== 'kanbo_wait_approval')
    expect(approving).toEqual([])
  })

  it('says nothing about a password when a driver\'s failure carries one', async () => {
    // On an external board the message under a failed tool call is the
    // driver's, and a driver is free to put the whole connection string in it.
    const failing = {
      cardGet: async () => {
        throw new Error('connection to postgres://user:secret@host:5432/db failed')
      },
    } as unknown as KanboToolTransport
    const tool = KANBO_TOOLS.find(candidate => candidate.name === 'kanbo_card_get')!

    const result = await tool.run(failing, { card: 'WOR-001' })

    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('postgres://user:***@host:5432/db')
    expect(result.content[0]?.text).not.toContain('secret')
  })

  it('tells an agent how to create a subtask, in kanbo_card_create and in its parent field', () => {
    const tool = KANBO_TOOLS.find(candidate => candidate.name === 'kanbo_card_create')!

    expect(tool.description).toContain('To create a subtask (sub-card) under another card, pass `parent` = that card\'s id')
    expect(tool.inputSchema.parent?.description).toContain('To create a subtask (sub-card) under another card, pass `parent` = that card\'s id')
  })

  it.each(KANBO_TOOL_NAMES)('%s performs exactly one board operation', async (name) => {
    const { transport, calls } = recordingTransport()
    const tool = KANBO_TOOLS.find(candidate => candidate.name === name)!

    const result = await tool.run(transport, TOOL_OPERATIONS[name].input)

    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toContain('the board')
    expect(calls).toEqual([TOOL_OPERATIONS[name].op])
  })
})

describe('the board\'s tools over a real board', () => {
  let board: TestBoardDatabase
  let transport: KanboDbTransport

  beforeEach(async () => {
    board = await createTestBoardDatabase()
    seedHostWorkspace(board, WORKSPACE.id, WORKSPACE.identifier)
    transport = await createDbTransport({ dbPath: board.path, workspaceId: WORKSPACE.id, actor: EXTERNAL })
  })

  afterEach(async () => {
    await transport.close()
    board.dispose()
  })

  function boardOps() {
    return createBoardOps(createSqliteBoardStore({ database: () => board.database }))
  }

  async function createCard(title: string) {
    return await boardOps().createCard({ workspace: WORKSPACE, title, statusName: 'To Do' }, EXTERNAL)
  }

  /** A client and the board's MCP server, talking to each other in this process. */
  async function connectClient(): Promise<Client> {
    const server = createKanboMcpServer(transport, { includeRunTools: true })
    const [clientChannel, serverChannel] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'board-test', version: '0.0.0' })
    await Promise.all([client.connect(clientChannel), server.connect(serverChannel)])
    return client
  }

  function readJson(result: CallToolResult): unknown {
    const [content] = result.content
    expect(content?.type).toBe('text')
    return JSON.parse(String((content as { text: string }).text))
  }

  /** The card `kanbo_card_get` prints, whichever transport the tool was handed. */
  async function readCardThrough(handed: KanboToolTransport, card: string): Promise<KanboCardResult> {
    const tool = KANBO_TOOLS.find(candidate => candidate.name === 'kanbo_card_get')!
    const result = await tool.run(handed, { card })
    expect(result.isError).toBeUndefined()
    return readJson(result) as KanboCardResult
  }

  it('offers every board tool to a client that asks', async () => {
    const client = await connectClient()

    const { tools } = await client.listTools()

    expect(tools.map(tool => tool.name).sort()).toEqual([...KANBO_TOOL_NAMES].sort())
    await client.close()
  })

  it('answers kanbo_card_get with the card', async () => {
    const card = await createCard('A card to read')
    const client = await connectClient()

    const result = await client.callTool({ name: 'kanbo_card_get', arguments: { card: card.id } }) as CallToolResult

    expect(result.isError).toBeFalsy()
    expect(readJson(result)).toMatchObject({ id: card.id, title: 'A card to read', columnSlug: 'to_do' })
    await client.close()
  })

  it('answers kanbo_card_get with the card\'s parent and its subtasks', async () => {
    const parent = await createCard('A card that splits')
    const client = await connectClient()

    const created = await client.callTool({
      name: 'kanbo_card_create',
      arguments: { description: 'The first part', parent: parent.id },
    }) as CallToolResult
    expect(created.isError).toBeFalsy()
    const child = readJson(created) as KanboCardResult

    expect(child).toMatchObject({ parentIssueId: parent.id, title: child.id })
    const read = await client.callTool({ name: 'kanbo_card_get', arguments: { card: parent.id } }) as CallToolResult
    expect(readJson(read)).toMatchObject({ id: parent.id, subCards: [{ id: child.id, title: child.id, columnSlug: child.columnSlug }] })
    const readChild = await client.callTool({ name: 'kanbo_card_get', arguments: { card: child.id } }) as CallToolResult
    expect(readJson(readChild)).toMatchObject({ parentIssueId: parent.id, subCards: [] })
    await client.close()
  })

  it('tells an agent in kanbo_prime to break work down with subtasks', async () => {
    const client = await connectClient()

    const result = await client.callTool({ name: 'kanbo_prime', arguments: {} }) as CallToolResult

    expect(String((result.content[0] as { text: string }).text))
      .toContain('Create subtasks only when the person asks for them')
    await client.close()
  })

  it('writes the line kanbo_status_line was given', async () => {
    const card = await createCard('A card being worked on')
    const client = await connectClient()

    const result = await client.callTool({
      name: 'kanbo_status_line',
      arguments: { card: card.id, text: 'reading the board' },
    }) as CallToolResult

    expect(result.isError).toBeFalsy()
    const written = await createSqliteBoardStore({ database: () => board.database }).issues.findById(card.id)
    expect(written?.statusLine).toBe('reading the board')
    await client.close()
  })

  it('prints the same card, and the same run on it, whichever end answered', async () => {
    // The board file hands back more than the server's routes do — the agent id
    // and the chat session behind a run among them. Both ends print one shape,
    // and it is not that one.
    const created = await createCard('A card being worked on')
    const run = await boardOps().startRun(created.id, { agentName: 'Claude', branch: 'feat/board' }, EXTERNAL)
    const card = (await createSqliteBoardStore({ database: () => board.database }).issues.findById(created.id))!
    const overHttp = createHttpTransport({
      workspaceId: () => WORKSPACE.id,
      // The statuses, and the sub-cards and comments `kanbo_card_get` lists with the card, are all empty here.
      request: async (_method, path) => path.includes('/statuses') || path.startsWith('/issues/?') || path.endsWith('/comments')
        ? []
        : serverCardShape(card, run),
    })

    const fromBoardFile = await readCardThrough(transport, card.id)
    const fromServer = await readCardThrough(overHttp, card.id)

    expect(Object.keys(fromBoardFile)).toEqual(Object.keys(fromServer))
    expect(Object.keys(fromBoardFile.activeRun!)).toEqual(Object.keys(fromServer.activeRun!))
    expect(Object.keys(fromBoardFile.activeRun!)).not.toContain('agentId')
    expect(Object.keys(fromBoardFile.activeRun!)).not.toContain('chatSessionId')
    expect(fromBoardFile.activeRun).toEqual(fromServer.activeRun)
  })

  it('takes the session kanbo_run_start is given, and the board file keeps it', async () => {
    const card = await createCard('A card being worked on')
    const client = await connectClient()

    const result = await client.callTool({
      name: 'kanbo_run_start',
      arguments: { card: card.id, agent: 'Claude', session: 'claude:abc-123' },
    }) as CallToolResult

    expect(result.isError).toBeFalsy()
    const written = (await boardOps().listRuns(card.id))[0]
    expect(written?.externalSessionRef).toBe('claude:abc-123')
  })

  it('reports an unparseable session as a tool error', async () => {
    const card = await createCard('A card being worked on')
    const tools = Object.fromEntries(KANBO_TOOLS.map(tool => [tool.name, tool]))

    const result = await tools.kanbo_run_start!.run(transport, { card: card.id, agent: 'Claude', session: 'gpt:abc' })

    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('board_run_session_ref_invalid')
  })

  it('forwards kanbo_run_start\'s session to the server as externalSessionRef', async () => {
    const bodies: Record<string, unknown>[] = []
    const overHttp = createHttpTransport({
      workspaceId: () => WORKSPACE.id,
      request: async (_method, _path, body) => {
        if (body) {
          bodies.push(body)
        }
        return {
          id: 'run-1',
          issueId: 'WOR-001',
          agentName: 'Claude',
          state: 'running',
          executionMode: 'worktree',
          branch: null,
          startedAt: 0,
          endedAt: null,
        }
      },
    })

    await overHttp.runStart({ card: 'WOR-001', agent: 'Claude', session: 'codex:session-9' })

    expect(bodies).toEqual([{ agentName: 'Claude', externalSessionRef: 'codex:session-9' }])
  })

  it('links a pull request through kanbo_card_link_pr, once, and lists it through kanbo_card_pull_requests', async () => {
    const card = await createCard('A card with a pull request')
    const client = await connectClient()

    const linked = await client.callTool({
      name: 'kanbo_card_link_pr',
      arguments: { card: card.id, url: 'https://github.com/octo/repo/pull/7' },
    }) as CallToolResult
    const again = await client.callTool({
      name: 'kanbo_card_link_pr',
      arguments: { card: card.id, url: 'octo/repo#7' },
    }) as CallToolResult
    const listed = await client.callTool({ name: 'kanbo_card_pull_requests', arguments: { card: card.id } }) as CallToolResult

    expect(linked.isError).toBeFalsy()
    const link = readJson(linked)
    expect(link).toEqual({
      id: expect.any(String),
      issueId: card.id,
      owner: 'octo',
      repo: 'repo',
      number: 7,
      url: 'https://github.com/octo/repo/pull/7',
      createdAt: expect.any(Number),
    })
    expect(readJson(again)).toEqual(link)
    expect(readJson(listed)).toEqual([link])
    await client.close()
  })

  it('reports what is not a pull request as a tool error, and prints a link the same from either end', async () => {
    const card = await createCard('A card with a pull request')
    const tools = Object.fromEntries(KANBO_TOOLS.map(tool => [tool.name, tool]))

    const refused = await tools.kanbo_card_link_pr!.run(transport, { card: card.id, url: 'https://github.com/octo/repo/issues/7' })
    expect(refused.isError).toBe(true)
    expect(refused.content[0]?.text).toContain('board_pull_request_invalid')

    const link = await boardOps().linkPullRequest(card.id, 'octo/repo#7', EXTERNAL)
    const asked: string[] = []
    const overHttp = createHttpTransport({
      workspaceId: () => WORKSPACE.id,
      // The server answers with the whole row, who linked it included.
      request: async (method, path) => {
        asked.push(`${method} ${path}`)
        return [link]
      },
    })
    const fromBoardFile = readJson(await tools.kanbo_card_pull_requests!.run(transport, { card: card.id }))
    const fromServer = readJson(await tools.kanbo_card_pull_requests!.run(overHttp, { card: card.id }))

    expect(asked).toEqual([`GET /issues/${card.id}/pull-requests`])
    expect(fromServer).toEqual(fromBoardFile)
    expect(Object.keys((fromBoardFile as object[])[0]!)).not.toContain('createdByKind')
  })

  it('lists the sprints through kanbo_sprints, the current one marked, the same from either end', async () => {
    // Sprint dates are calendar days (ruling 5x-6): yesterday through tomorrow, then later.
    const DAY = 86_400
    const today = Math.floor(Date.now() / 1000 / DAY) * DAY
    const ops = boardOps()
    const current = await ops.createMilestone({ workspaceId: WORKSPACE.id, title: 'Now', startDate: today - DAY, dueDate: today + DAY })
    await ops.createMilestone({ workspaceId: WORKSPACE.id, title: 'Later', startDate: today + 2 * DAY, dueDate: today + 3 * DAY })
    const tools = Object.fromEntries(KANBO_TOOLS.map(tool => [tool.name, tool]))

    const fromBoardFile = readJson(await tools.kanbo_sprints!.run(transport, {})) as { id: string, current: boolean }[]
    expect(fromBoardFile).toEqual([
      { id: current.id, title: 'Now', status: 'open', startDate: today - DAY, dueDate: today + 2 * DAY - 1, current: true, openCards: 0, doneCards: 0 },
      expect.objectContaining({ title: 'Later', current: false }),
    ])

    const asked: string[] = []
    const overHttp = createHttpTransport({
      workspaceId: () => WORKSPACE.id,
      // The server answers with the sprint as the operation returns it, description and timestamps included.
      request: async (method, path) => {
        asked.push(`${method} ${path}`)
        return await ops.listSprints(WORKSPACE.id)
      },
    })
    const fromServer = readJson(await tools.kanbo_sprints!.run(overHttp, {}))
    expect(asked).toEqual([`GET /issues/sprints?workspaceId=${WORKSPACE.id}`])
    expect(fromServer).toEqual(fromBoardFile)
  })

  it('reports a column this board does not have as a tool error, rather than throwing', async () => {
    const card = await createCard('A card that stays put')
    const move = KANBO_TOOLS.find(tool => tool.name === 'kanbo_card_move')!

    const result = await move.run(transport, { card: card.id, column: 'nowhere' })

    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('issue_status_not_found')
  })

  it('refuses a move into a column whose entry rules the card does not meet, one line per rule', async () => {
    const ops = boardOps()
    await ops.ensureDefaultColumns(WORKSPACE.id)
    await ops.setColumnEntryRules(WORKSPACE.id, 'In Review', ['pull_request_linked', 'approved'], { kind: 'user', id: '__self__' })
    const card = await createCard('Not ready yet')
    const tools = Object.fromEntries(KANBO_TOOLS.map(tool => [tool.name, tool]))

    const result = await tools.kanbo_card_move!.run(transport, { card: card.id, column: 'in_review' })

    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toBe([
      `board_column_rules_unmet: ${card.id} cannot enter "In Review" yet:`,
      '- pull_request_linked: no pull request linked',
      '- approved: not approved by a person',
    ].join('\n'))
    expect((await ops.requireColumn(WORKSPACE.id, 'to-do')).id).toBe(card.statusId)

    // The columns carry their rules, and the prime text says them.
    const columns = readJson(await tools.kanbo_columns!.run(transport, {})) as { slug: string, entryRules: string[] }[]
    expect(columns.find(column => column.slug === 'in_review')?.entryRules).toEqual(['pull_request_linked', 'approved'])
    expect(columns.find(column => column.slug === 'done')?.entryRules).toEqual([])
    const prime = (await tools.kanbo_prime!.run(transport, {})).content[0]?.text
    expect(prime).toContain('- In Review (`in_review`) — Work done; being checked, or waiting for a person Requires: pull_request_linked (')
    expect(prime).toContain('A column that lists requirements refuses a card')
  })

  it('reads a column\'s rules from the server whether it sends the stored text or a list', async () => {
    const ops = boardOps()
    await ops.ensureDefaultColumns(WORKSPACE.id)
    const column = await ops.setColumnEntryRules(WORKSPACE.id, 'Done', ['approved'], { kind: 'user', id: '__self__' })
    const tools = Object.fromEntries(KANBO_TOOLS.map(tool => [tool.name, tool]))
    const over = (answer: (rows: unknown[]) => unknown[]) => createHttpTransport({
      workspaceId: () => WORKSPACE.id,
      request: async () => answer(await ops.listColumns(WORKSPACE.id)),
    })

    const asStored = readJson(await tools.kanbo_columns!.run(over(rows => rows), {})) as { id: string, entryRules: string[] }[]
    const asList = readJson(await tools.kanbo_columns!.run(over(rows => rows.map(row => ({
      ...(row as object),
      entryRules: (row as { id: string }).id === column.id ? ['approved'] : null,
    }))), {})) as { id: string, entryRules: string[] }[]

    expect(asStored.find(row => row.id === column.id)?.entryRules).toEqual(['approved'])
    expect(asList).toEqual(asStored)
  })

  /**
   * A server of the `/issues` routes, answering from this board the way
   * `kanbo serve` does — and filtering on no more than it does: one column and
   * one parent. Whatever else a query names, the transport has to apply itself.
   */
  function overHttpFromBoard() {
    const ops = boardOps()
    const store = createSqliteBoardStore({ database: () => board.database })
    return createHttpTransport({
      workspaceId: () => WORKSPACE.id,
      request: async (_method, path) => {
        const [route, search] = path.split('?') as [string, string | undefined]
        const query = new URLSearchParams(search)
        if (route === '/issues/statuses') {
          return await ops.listColumns(WORKSPACE.id)
        }
        if (route === '/issues/ready') {
          return await toCardViews(ops, await ops.listReady({ workspaceId: WORKSPACE.id }))
        }
        if (route === '/issues/') {
          const rows = (await store.issues.listInBoardOrder(WORKSPACE.id))
            .filter(row => !query.has('statusId') || row.statusId === query.get('statusId'))
            .filter(row => !query.has('parentIssueId') || row.parentIssueId === query.get('parentIssueId'))
          return await toCardViews(ops, rows)
        }
        const [, , id, part] = route.split('/')
        if (part === 'comments') {
          return await ops.listComments(id!)
        }
        if (part === 'runs') {
          return await ops.listRuns(id!)
        }
        if (part === 'field-changes') {
          return await ops.listFieldChanges(id!)
        }
        if (part === 'pull-requests') {
          return await ops.listPullRequests(id!)
        }
        return await toCardView(ops, (await store.issues.findById(id!))!)
      },
    })
  }

  function readText(result: { content: { text: string }[] }): string {
    return result.content[0]!.text
  }

  it('answers kanbo_card_list with a page of compact cards, the total, and where the next page starts', async () => {
    for (let index = 1; index <= 3; index++) {
      await boardOps().createCard({ workspace: WORKSPACE, title: `Card ${index}`, description: 'A long description', statusName: 'To Do' }, EXTERNAL)
    }
    const tools = Object.fromEntries(KANBO_TOOLS.map(tool => [tool.name, tool]))

    const text = readText(await tools.kanbo_card_list!.run(transport, { limit: 2 }))

    expect(text.split('\n')).toHaveLength(4)
    expect(JSON.parse(text)).toEqual({
      total: 3,
      more: 1,
      nextOffset: 2,
      cards: [
        { id: 'WOR-001', title: 'Card 1', column: 'to_do', updatedAt: expect.any(Number) },
        { id: 'WOR-002', title: 'Card 2', column: 'to_do', updatedAt: expect.any(Number) },
      ],
    })
    expect(JSON.parse(readText(await tools.kanbo_card_list!.run(transport, { offset: 2 })))).toMatchObject({
      total: 3,
      offset: 2,
      cards: [{ id: 'WOR-003' }],
    })
    expect(JSON.parse(readText(await tools.kanbo_card_list!.run(transport, { limit: 1, fields: ['description', 'priority'] }))).cards)
      .toEqual([{ id: 'WOR-001', description: 'A long description', priority: 'none' }])
    expect(JSON.parse(readText(await tools.kanbo_card_list!.run(transport, { limit: 1, detail: 'full' }))).cards[0])
      .toMatchObject({ id: 'WOR-001', description: 'A long description', columnSlug: 'to_do', labels: [] })
  })

  it('picks the same cards with every filter, from the board file and over HTTP', async () => {
    const ops = boardOps()
    const parent = await createCard('Parent')
    const waiting = await ops.createCard({ workspace: WORKSPACE, title: 'Waiting', statusName: 'In Review' }, EXTERNAL)
    await ops.waitApproval(waiting.id, {}, EXTERNAL)
    const running = await ops.createCard({ workspace: WORKSPACE, title: 'Running', statusName: 'In Progress', parentIssueId: parent.id }, EXTERNAL)
    await ops.startRun(running.id, { agentName: 'Claude' }, EXTERNAL)
    const labelled = await ops.createCard({ workspace: WORKSPACE, title: 'Labelled', description: 'About the Parser', statusName: 'Backlog' }, EXTERNAL)
    await ops.updateCard(labelled.id, { labels: ['ui'], priority: 'high' }, EXTERNAL)
    const tools = Object.fromEntries(KANBO_TOOLS.map(tool => [tool.name, tool]))
    const overHttp = overHttpFromBoard()

    const questions: [Record<string, unknown>, string[]][] = [
      [{ waitingForPerson: true }, [waiting.id]],
      [{ hasActiveRun: true }, [running.id]],
      [{ parent: parent.id }, [running.id]],
      [{ columns: ['in_review', 'backlog'] }, [waiting.id, labelled.id]],
      [{ column: 'in_progress', columns: ['in_review'] }, [waiting.id, running.id]],
      [{ text: 'parser' }, [labelled.id]],
      [{ labels: ['ui'], priority: ['high'] }, [labelled.id]],
      [{ updatedSince: '2000-01-01T00:00:00Z', waitingForPerson: false, hasActiveRun: false }, [parent.id, labelled.id]],
      [{ updatedSince: 4_000_000_000 }, []],
    ]
    for (const [input, expected] of questions) {
      const fromBoardFile = readText(await tools.kanbo_card_list!.run(transport, input))
      const fromServer = readText(await tools.kanbo_card_list!.run(overHttp, input))
      expect(JSON.parse(fromBoardFile).cards.map((card: { id: string }) => card.id), JSON.stringify(input)).toEqual(expected)
      expect(fromServer, JSON.stringify(input)).toBe(fromBoardFile)
    }

    const refused = await tools.kanbo_card_list!.run(transport, { updatedSince: 'last tuesday-ish' })
    expect(refused.isError).toBe(true)
    expect(readText(refused)).toContain('updatedSince')
  })

  it('answers kanbo_ready with ten cards by default, and how many are ready in all', async () => {
    for (let index = 1; index <= 12; index++) {
      await createCard(`Ready ${index}`)
    }
    const tools = Object.fromEntries(KANBO_TOOLS.map(tool => [tool.name, tool]))

    const fromBoardFile = readText(await tools.kanbo_ready!.run(transport, {}))
    const page = JSON.parse(fromBoardFile)

    expect(page).toMatchObject({ total: 12, more: 2, nextOffset: 10 })
    expect(page.cards).toHaveLength(10)
    expect(page.cards[0]).toEqual({ id: 'WOR-001', title: 'Ready 1', column: 'to_do', updatedAt: expect.any(Number) })
    expect(readText(await tools.kanbo_ready!.run(overHttpFromBoard(), {}))).toBe(fromBoardFile)
    expect(JSON.parse(readText(await tools.kanbo_ready!.run(transport, { offset: 10 }))).cards.map((card: { id: string }) => card.id))
      .toEqual(['WOR-011', 'WOR-012'])
  })

  it('reads a card with its latest comments and sub-cards, and on request its runs, history and pull requests, the same from either end', async () => {
    const ops = boardOps()
    const parent = await createCard('Parent')
    await ops.createCard({ workspace: WORKSPACE, title: 'Child', statusName: 'To Do', parentIssueId: parent.id }, EXTERNAL)
    for (let index = 1; index <= 12; index++) {
      await ops.addComment({ issueId: parent.id, content: `Comment ${index}` }, EXTERNAL)
    }
    const tools = Object.fromEntries(KANBO_TOOLS.map(tool => [tool.name, tool]))
    const overHttp = overHttpFromBoard()

    const byDefault = readJson(await tools.kanbo_card_get!.run(transport, { card: parent.id })) as Record<string, any>
    expect(byDefault.subCards).toEqual([{ id: 'WOR-002', title: 'Child', columnSlug: 'to_do' }])
    expect(byDefault.commentCount).toBe(12)
    expect(byDefault.comments.map((comment: { content: string }) => comment.content))
      .toEqual(Array.from({ length: 10 }, (_, index) => `Comment ${index + 3}`))
    expect(byDefault.comments[0]).toEqual({ id: expect.any(String), author: 'system', content: 'Comment 3', createdAt: expect.any(Number) })
    expect(byDefault).not.toHaveProperty('runs')
    expect(readJson(await tools.kanbo_card_get!.run(overHttp, { card: parent.id }))).toEqual(byDefault)

    await ops.startRun(parent.id, { agentName: 'Claude' }, EXTERNAL)
    await ops.setStatusLine(parent.id, 'working', EXTERNAL)
    await ops.linkPullRequest(parent.id, 'octo/repo#7', EXTERNAL)

    const everything = { card: parent.id, include: ['comments', 'subCards', 'runs', 'history', 'prs'], commentLimit: 2 }
    const full = readJson(await tools.kanbo_card_get!.run(transport, everything)) as Record<string, any>
    expect(full.comments).toHaveLength(2)
    expect(full.runs).toEqual([expect.objectContaining({ agentName: 'Claude', state: 'running' })])
    expect(full.history).toContainEqual(expect.objectContaining({ field: 'statusLine', to: 'working', actor: 'system' }))
    expect(full.pullRequests).toEqual([expect.objectContaining({ owner: 'octo', repo: 'repo', number: 7 })])
    expect(readJson(await tools.kanbo_card_get!.run(overHttp, everything))).toEqual(full)

    const alone = readJson(await tools.kanbo_card_get!.run(transport, { card: parent.id, include: [] }))
    expect(Object.keys(alone as object)).not.toContain('subCards')
    expect(Object.keys(alone as object)).not.toContain('comments')
  })
})

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import type { BoardWorkspaceIdentity } from '../domain/numbering'
import { createBoardOps } from '../ops'
import type { BoardActor } from '../ops/types'
import { toCardView, toCardViews } from '../serve/views'
import { createSqliteBoardStore } from '../sqlite/board-store.sqlite'
import type { Issue, IssueRun } from '../sqlite/schema'
import type { TestBoardDatabase } from '../testing/board-database'
import { createTestBoardDatabase, seedHostWorkspace } from '../testing/board-database'
import type { KanboCompactCard } from './card-output'
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
 * hands its answer on — `kanbo_prime` reads `text` off it, a tool that wrote a
 * card prints it as a card, the rest print it.
 */
function recordingTransport(): { transport: KanboToolTransport, calls: string[] } {
  const calls: string[] = []
  const operations = new Set(Object.values(TOOL_OPERATIONS).map(entry => entry.op))
  const card = { id: 'WOR-001', title: 'the board', columnSlug: null, attemptCount: 0, activeRun: null, updatedAt: 0 }
  const transport = Object.fromEntries(Array.from(operations, op => [op, async () => {
    calls.push(op)
    // A list tool prints a page of cards; one card called "the board" is enough of one.
    return op.endsWith('Page')
      ? { cards: [card], total: 1, offset: 0 }
      : { ...card, text: 'the board' }
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
    const child = readJson(created) as KanboCompactCard

    expect(child).toMatchObject({ parentId: parent.id, title: 'The first part' })
    const read = await client.callTool({ name: 'kanbo_card_get', arguments: { card: parent.id } }) as CallToolResult
    expect(readJson(read)).toMatchObject({ id: parent.id, subCards: [{ id: child.id, title: child.id, columnSlug: child.column }] })
    const readChild = await client.callTool({ name: 'kanbo_card_get', arguments: { card: child.id } }) as CallToolResult
    expect(readJson(readChild)).toMatchObject({ parentIssueId: parent.id, subCards: [] })
    await client.close()
  })

  it('puts a card under another with kanbo_card_update parent, by its key, back on the top level with "none", and reads a null parent as not given', async () => {
    const parent = await createCard('Parent')
    const card = await createCard('Created at the wrong level')
    const client = await connectClient()
    const update = async (args: Record<string, unknown>) => await client.callTool({ name: 'kanbo_card_update', arguments: { card: card.id, ...args } }) as CallToolResult
    const text = (result: CallToolResult) => (result.content[0] as { text: string }).text
    const parentOf = async (id: string) =>
      (readJson(await client.callTool({ name: 'kanbo_card_get', arguments: { card: id, include: [] } }) as CallToolResult) as KanboCardResult).parentIssueId

    expect(readJson(await update({ parent: 'WOR-1' }))).toMatchObject({ id: card.id, parentId: parent.id })
    expect(await parentOf(card.id)).toBe(parent.id)

    // Models send null for the fields they are not changing: that must not take the card out from under its parent.
    expect(readJson(await update({ title: 'Renamed', parent: null }))).toMatchObject({ title: 'Renamed', parentId: parent.id })
    const nothing = await update({ parent: null })
    expect(nothing.isError).toBe(true)
    expect(text(nothing)).toBe('Nothing to update. Pass title, description, priority, labels, executionMode or parent.')

    expect(readJson(await update({ parent: 'none' }))).not.toHaveProperty('parentId')
    expect(await parentOf(card.id)).toBeNull()

    const unknown = await update({ parent: 'WOR-404' })
    expect(unknown.isError).toBe(true)
    expect(text(unknown)).toContain('No card "WOR-404" on this board.')

    await update({ parent: parent.id })
    const cycle = await client.callTool({ name: 'kanbo_card_update', arguments: { card: parent.id, parent: card.id } }) as CallToolResult
    expect(cycle.isError).toBe(true)
    expect(text(cycle)).toBe(`issue_parent_cycle {"issueId":"${parent.id}","parentIssueId":"${card.id}"}`)
    expect(await parentOf(parent.id)).toBeNull()
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

  it('sends kanbo_card_update\'s parent to the server as parentIssueId — null for "none" — and no parent at all when none was given', async () => {
    const card = await createCard('A card')
    const ops = boardOps()
    const writes: { path: string, body: Record<string, unknown> | undefined }[] = []
    const overHttp = createHttpTransport({
      workspaceId: () => WORKSPACE.id,
      request: async (method, path, body) => {
        if (method === 'PATCH') {
          writes.push({ path, body })
        }
        return path.startsWith('/issues/statuses') ? await ops.listColumns(WORKSPACE.id) : await toCardView(ops, card)
      },
    })
    const update = KANBO_TOOLS.find(tool => tool.name === 'kanbo_card_update')!

    for (const args of [{ parent: 'WOR-002' }, { parent: 'none' }, { title: 'Renamed' }, { title: 'Again', parent: null }]) {
      expect((await update.run(overHttp, { card: card.id, ...args })).isError, JSON.stringify(args)).toBeUndefined()
    }

    expect(writes).toStrictEqual([
      { path: `/issues/${card.id}`, body: { parentIssueId: 'WOR-002' } },
      { path: `/issues/${card.id}`, body: { parentIssueId: null } },
      { path: `/issues/${card.id}`, body: { title: 'Renamed' } },
      { path: `/issues/${card.id}`, body: { title: 'Again' } },
    ])
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

  it('answers every tool that writes a card with the card compact, on one line, and in full on detail: "full" — the same over HTTP', async () => {
    const parent = await createCard('Parent')
    const ops = boardOps()
    const store = createSqliteBoardStore({ database: () => board.database })
    const tools = Object.fromEntries(KANBO_TOOLS.map(tool => [tool.name, tool]))
    // A server that writes nothing and answers every write with WOR-002 as the board holds it
    // now: how much of the card comes back is the tool's to decide, not the transport's.
    const overHttp = createHttpTransport({
      workspaceId: () => WORKSPACE.id,
      request: async (_method, path) => path.startsWith('/issues/statuses')
        ? await ops.listColumns(WORKSPACE.id)
        : await toCardView(ops, (await store.issues.findById('WOR-002'))!),
    })
    const card = { id: 'WOR-002', title: 'Write the parser', parentId: parent.id, updatedAt: expect.any(Number) }
    const writes: [KanboToolName, Record<string, unknown>, Record<string, unknown>][] = [
      ['kanbo_card_create', { title: 'Write the parser', description: 'A long description', column: 'to_do', parent: parent.id }, { ...card, column: 'to_do' }],
      ['kanbo_card_update', { card: 'WOR-002', priority: 'high' }, { ...card, column: 'to_do' }],
      ['kanbo_card_move', { card: 'WOR-002', column: 'in_progress' }, { ...card, column: 'in_progress' }],
      ['kanbo_status_line', { card: 'WOR-002', text: 'writing the test' }, { ...card, column: 'in_progress', statusLine: 'writing the test' }],
      ['kanbo_wait_approval', { card: 'WOR-002', text: 'look at the diff' }, { ...card, column: 'in_progress', statusLine: 'look at the diff', waitingFor: 'human' }],
    ]

    for (const [name, args, compact] of writes) {
      const text = readText(await tools[name]!.run(transport, args))
      expect(text, name).not.toContain('\n')
      expect(JSON.parse(text), name).toEqual(compact)
      expect(readText(await tools[name]!.run(overHttp, args)), name).toBe(text)
    }

    // Every field, as these tools answered before: the card as kanbo_card_get prints it alone.
    for (const [name, args] of writes.slice(1)) {
      const full = readText(await tools[name]!.run(transport, { ...args, detail: 'full' }))
      expect(full, name).toContain('\n  "description": "A long description",\n')
      expect(JSON.parse(full), name).toMatchObject({ id: 'WOR-002', columnSlug: 'in_progress', priority: 'high', labels: [], parentIssueId: parent.id })
      expect(full, name).toBe(readText(await tools.kanbo_card_get!.run(transport, { card: 'WOR-002', include: [] })))
    }
    const created = readText(await tools.kanbo_card_create!.run(transport, { description: 'Only a description', detail: 'full' }))
    expect(created).toBe(readText(await tools.kanbo_card_get!.run(transport, { card: 'WOR-003', include: [] })))

    // `detail` says how to answer; it is not a field to change.
    const nothing = await tools.kanbo_card_update!.run(transport, { card: 'WOR-002', detail: 'full' })
    expect(nothing.isError).toBe(true)
    expect(readText(nothing)).toBe('Nothing to update. Pass title, description, priority, labels, executionMode or parent.')
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

    // A parent is named the way any card is; over HTTP it is resolved before
    // the server, which filters on the id alone, is asked.
    const parentNumber = String(parent.number)
    for (const spelling of [parent.id, `${parent.id.split('-')[0]!.toLowerCase()}-${parentNumber}`, parentNumber]) {
      const fromBoardFile = readText(await tools.kanbo_card_list!.run(transport, { parent: spelling }))
      expect(JSON.parse(fromBoardFile).cards.map((card: { id: string }) => card.id), spelling).toEqual([running.id])
      expect(readText(await tools.kanbo_card_list!.run(overHttp, { parent: spelling })), spelling).toBe(fromBoardFile)
    }
    const unknownParent = await tools.kanbo_card_list!.run(overHttp, { parent: 'WOR-404' })
    expect(unknownParent.isError).toBe(true)
    expect(readText(unknownParent)).toBe('issue_not_found {"issueId":"WOR-404"}')
    expect((await tools.kanbo_card_list!.run(transport, { parent: 'WOR-404' })).isError).toBe(true)

    for (const [updatedSince, reason] of [
      ['last tuesday-ish', 'neither unix seconds nor an ISO date'],
      [Date.now(), 'looks like milliseconds — pass seconds or an ISO date'],
      ['2026-09-28T10:00:00', 'has no time zone'],
    ] as const) {
      const refused = await tools.kanbo_card_list!.run(transport, { updatedSince })
      expect(refused.isError, String(updatedSince)).toBe(true)
      expect(readText(refused)).toContain(`updatedSince: `)
      expect(readText(refused)).toContain(reason)
    }
  })

  it('publishes each tool\'s canonical JSON Schema, while an aliased or missing argument reaches the tool and is answered in a sentence', async () => {
    const client = await connectClient()
    const { tools } = await client.listTools()
    for (const tool of KANBO_TOOLS) {
      const published = tools.find(candidate => candidate.name === tool.name)!.inputSchema
      const { $schema: _published, ...rest } = published as Record<string, unknown>
      const { $schema: _canonical, ...canonical } = z.toJSONSchema(z.object(tool.inputSchema), { io: 'input', target: 'draft-7' }) as Record<string, unknown>
      expect(rest, tool.name).toEqual(canonical)
    }

    const call = async (name: string, args: Record<string, unknown>) => await client.callTool({ name, arguments: args }) as CallToolResult
    const text = (result: CallToolResult) => (result.content[0] as { text: string }).text
    const card = await createCard('A card to talk about')

    // The names agents reached for, measured: `text` for a comment, `id` for a card, `content` for a status line.
    expect((await call('kanbo_card_comment', { card: card.id, text: 'Via text' })).isError).toBeFalsy()
    expect((await call('kanbo_card_comment', { id: card.id, content: 'Via id' })).isError).toBeFalsy()
    expect((await call('kanbo_card_get', { cardId: card.id })).isError).toBeFalsy()
    expect((await call('kanbo_card_get', { key: card.id })).isError).toBeFalsy()
    expect((await call('kanbo_status_line', { id: card.id, content: 'Reading the card' })).isError).toBeFalsy()
    expect(readJson(await call('kanbo_card_move', { id: card.id, to: 'in_progress' }))).toMatchObject({ column: 'in_progress' })
    expect((await boardOps().listComments(card.id)).map(comment => comment.content)).toEqual(expect.arrayContaining(['Via text', 'Via id']))
    expect(readJson(await call('kanbo_card_get', { card: card.id, include: [] }))).toMatchObject({ statusLine: 'Reading the card' })

    const missing = await call('kanbo_card_get', {})
    expect(missing.isError).toBe(true)
    expect(text(missing)).toBe('kanbo_card_get needs `card` (the card id, e.g. TST-5). Example: {"card":"TST-5"}')
    const noContent = await call('kanbo_card_comment', { card: card.id })
    expect(text(noContent)).toBe('kanbo_card_comment needs `content` (the comment text). Example: {"card":"TST-5","content":"Added slugify(text) and a test; npm test passes."}')
    const both = await call('kanbo_card_comment', { card: card.id, content: 'One', text: 'Two' })
    expect(both.isError).toBe(true)
    expect(text(both)).toContain('kanbo_card_comment got `content` and `text` with different values; send only `content`.')
    expect((await call('kanbo_card_comment', { card: card.id, content: 'Same', text: 'Same' })).isError).toBeFalsy()
    const wrongType = await call('kanbo_card_list', { limit: 'ten' })
    expect(text(wrongType)).toBe('kanbo_card_list `limit` must be a number. Example: {"waitingForPerson":true}')
    await client.close()
  })

  it('reads the finish states agents write for the three it keeps, and names the finish call when a run starts', async () => {
    const client = await connectClient()
    const call = async (name: string, args: Record<string, unknown>) => await client.callTool({ name, arguments: args }) as CallToolResult
    const text = (result: CallToolResult) => (result.content[0] as { text: string }).text

    for (const [written, stored] of [['completed', 'finished'], ['succeeded', 'finished'], ['Done', 'finished'], ['errored', 'failed'], ['cancelled', 'stopped'], ['aborted', 'stopped']] as const) {
      const card = await createCard(`Run ${written}`)
      const started = readJson(await call('kanbo_run_start', { id: card.id, agentName: 'Claude' })) as { id: string, finishWith: string }
      expect(started.finishWith).toBe(`kanbo_run_finish {"run":"${started.id}","state":"finished"}`)
      const finished = await call('kanbo_run_finish', { runId: started.id, state: written })
      expect(finished.isError, written).toBeFalsy()
      expect(readJson(finished)).toMatchObject({ id: started.id, state: stored })
    }
    const refused = await call('kanbo_run_finish', { run: 'run-1', state: 'maybe' })
    expect(text(refused)).toBe('kanbo_run_finish `state` must be one of finished, failed, stopped. Example: {"run":"<the id kanbo_run_start gave back>","state":"finished"}')
    await client.close()
  })

  it('fills in the session of the agent whose environment it runs in, when kanbo_run_start names none', async () => {
    const card = await createCard('A card started from Claude Code')
    const client = await connectClient()
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'fa78a41d-01a7-48f0-a157-eff77adad091')
    try {
      await client.callTool({ name: 'kanbo_run_start', arguments: { card: card.id, agent: 'Claude' } })
    }
    finally {
      vi.unstubAllEnvs()
    }
    expect((await boardOps().listRuns(card.id))[0]?.externalSessionRef).toBe('claude:fa78a41d-01a7-48f0-a157-eff77adad091')
    await client.close()
  })

  it('lists the cards a person sent back, each with the person\'s comment, first in kanbo_ready and kanbo_prime — the same over HTTP', async () => {
    const ops = boardOps()
    const PERSON: BoardActor = { kind: 'user', id: 'ann' }
    const sentBack = await ops.createCard({ workspace: WORKSPACE, title: 'Sent back', statusName: 'In Review' }, EXTERNAL)
    await ops.waitApproval(sentBack.id, {}, EXTERNAL)
    await ops.returnCard(sentBack.id, { comment: 'slugify("!!!") must be empty' }, PERSON)
    const waiting = await ops.createCard({ workspace: WORKSPACE, title: 'Waiting', statusName: 'In Review' }, EXTERNAL)
    await ops.addComment({ issueId: waiting.id, content: 'Is the new name right?' }, { kind: 'agent', id: 'claude' })
    await ops.waitApproval(waiting.id, {}, EXTERNAL)
    const approved = await ops.createCard({ workspace: WORKSPACE, title: 'Approved after a return', statusName: 'In Review' }, EXTERNAL)
    await ops.returnCard(approved.id, { comment: 'not yet' }, PERSON)
    await ops.approve(approved.id, { comment: null }, PERSON)
    await createCard('Ready')
    const tools = Object.fromEntries(KANBO_TOOLS.map(tool => [tool.name, tool]))
    const overHttp = overHttpFromBoard()

    const returned = JSON.parse(readText(await tools.kanbo_card_list!.run(transport, { returned: true })))
    expect(returned.cards).toEqual([expect.objectContaining({
      id: sentBack.id,
      column: 'in_progress',
      statusLine: 'returned by a person: slugify("!!!") must be empty',
      returned: true,
      lastComment: { author: 'user', text: 'slugify("!!!") must be empty', createdAt: expect.any(Number) },
    })])
    // "What is waiting for me" in one call: each waiting card says what it asks.
    const waitingList = JSON.parse(readText(await tools.kanbo_card_list!.run(transport, { waitingForPerson: true })))
    expect(waitingList.cards).toEqual([expect.objectContaining({
      id: waiting.id,
      waitingFor: 'human',
      lastComment: { author: 'agent', text: 'Is the new name right?', createdAt: expect.any(Number) },
    })])
    for (const input of [{ returned: true }, { returned: false }, { waitingForPerson: true }, {}]) {
      expect(readText(await tools.kanbo_card_list!.run(overHttp, input)), JSON.stringify(input))
        .toBe(readText(await tools.kanbo_card_list!.run(transport, input)))
    }

    const ready = readText(await tools.kanbo_ready!.run(transport, {}))
    expect(ready.indexOf(sentBack.id)).toBeLessThan(ready.indexOf('"total"'))
    expect(JSON.parse(ready)).toMatchObject({ returned: [{ id: sentBack.id, returned: true }], total: 1, cards: [{ title: 'Ready' }] })
    expect(readText(await tools.kanbo_ready!.run(overHttp, {}))).toBe(ready)
    expect(JSON.parse(readText(await tools.kanbo_ready!.run(transport, { offset: 1 }))).returned).toBeUndefined()

    const prime = readText(await tools.kanbo_prime!.run(transport, {}))
    expect(prime.split('\n').slice(0, 3)).toEqual([
      'Returned to you — a person sent these back. Read their comment, do what it asks, then hand the card back to a person:',
      '',
      `- ${sentBack.id} Sent back (\`in_progress\`) — person: "slugify(\\"!!!\\") must be empty"`,
    ])

    // Picked up again, it is no longer "returned"; handed back, neither.
    const run = await ops.startRun(sentBack.id, { agentName: 'Claude' }, EXTERNAL)
    expect(JSON.parse(readText(await tools.kanbo_card_list!.run(transport, { returned: true }))).cards).toEqual([])
    await ops.finishRun(run.id, { state: 'finished' }, EXTERNAL)
    expect(JSON.parse(readText(await tools.kanbo_card_list!.run(transport, { returned: true }))).cards).toHaveLength(1)
    await ops.waitApproval(sentBack.id, {}, EXTERNAL)
    expect(JSON.parse(readText(await tools.kanbo_card_list!.run(transport, { returned: true }))).cards).toEqual([])
    expect(readText(await tools.kanbo_prime!.run(transport, {}))).toMatch(/^Columns of this board/)
  })

  it('finds text ignoring case beyond ASCII, from the board file and over HTTP alike', async () => {
    const umlaut = await createCard('Über die Brücke')
    await createCard('Unrelated')
    const tools = Object.fromEntries(KANBO_TOOLS.map(tool => [tool.name, tool]))
    const overHttp = overHttpFromBoard()

    for (const text of ['über', 'ÜBER', 'brÜcke']) {
      const fromBoardFile = readText(await tools.kanbo_card_list!.run(transport, { text }))
      expect(JSON.parse(fromBoardFile).cards.map((card: { id: string }) => card.id), text).toEqual([umlaut.id])
      expect(readText(await tools.kanbo_card_list!.run(overHttp, { text })), text).toBe(fromBoardFile)
    }
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

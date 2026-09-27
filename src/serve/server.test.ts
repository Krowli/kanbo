import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { BoardSession } from '../cli/command'
import type { BoardWorkspaceIdentity } from '../domain/numbering'
import { createBoardOps } from '../ops'
import type { TestBoardStore } from '../testing/board-stores'
import { BOARD_STORE_FACTORIES } from '../testing/board-stores'
import type { ServeActors } from './actors'
import type { KanboServeOptions, RunningKanboServer } from './server'
import { SERVE_BODY_LIMIT_BYTES, SERVE_TOKEN_REQUIRED_MESSAGE, startKanboServer } from './server'
import type { ServeCardView } from './views'

const WORKSPACE: BoardWorkspaceIdentity = { id: 'workspace', identifier: 'WOR', name: 'Workspace' }
const OTHER_WORKSPACE: BoardWorkspaceIdentity = { id: 'other', identifier: 'OTH', name: 'Other' }

/** A server started by a person: writes are `external`, and approve and return act for that person. */
const PERSON_ACTORS: ServeActors = {
  writer: { kind: 'external', id: 'tester', name: 'test-host' },
  person: { kind: 'user', id: 'tester' },
}

/**
 * Every field the `/issues` routes answer a card with, spelled out as a
 * record over the package's own view type: a field added to or dropped from
 * `ServeCardView` fails to compile here, and a response carrying anything else
 * fails the test below.
 */
const ISSUE_VIEW_FIELDS: Record<Exclude<keyof ServeCardView, 'unmetRules'>, true> = {
  id: true,
  workspaceId: true,
  number: true,
  statusId: true,
  milestoneId: true,
  parentIssueId: true,
  title: true,
  description: true,
  priority: true,
  labels: true,
  assigneeKind: true,
  assigneeId: true,
  dueDate: true,
  createdByKind: true,
  createdById: true,
  sourceChatSessionId: true,
  delegateAgentId: true,
  delegateProviderTargetId: true,
  contextRefs: true,
  statusLine: true,
  waitingFor: true,
  executionMode: true,
  order: true,
  createdAt: true,
  updatedAt: true,
  attemptCount: true,
  activeRun: true,
}

function sessionOn(store: TestBoardStore['store']): BoardSession {
  return { ops: createBoardOps(store), store, workspace: WORKSPACE, assertWritable: async () => {} }
}

/** The token the servers below are started with, unless a test says otherwise. */
const TOKEN = 'right-token'

/** A server as a test calls it: where it is, and the token a caller holds for it, if any. */
interface Client {
  server: RunningKanboServer
  token?: string
}

/**
 * One call to the server, answered as status, headers and JSON. A request that
 * is not a GET says it is JSON, and the caller's token goes with it, unless the
 * test says otherwise in `headers`. The JSON is read as loosely as an assertion
 * on it needs: what it must be is what each test asserts.
 */
async function call(
  client: Client,
  method: string,
  path: string,
  init: { body?: unknown, rawBody?: string, headers?: Record<string, string> } = {},
  // eslint-disable-next-line ts/no-explicit-any -- see above
): Promise<{ status: number, headers: Headers, json: any }> {
  const body = init.rawBody ?? (init.body === undefined ? undefined : JSON.stringify(init.body))
  const response = await fetch(`${client.server.url}${path}`, {
    method,
    headers: {
      ...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
      ...(client.token ? { authorization: `Bearer ${client.token}` } : {}),
      ...init.headers,
    },
    body,
  })
  const text = await response.text()
  return { status: response.status, headers: response.headers, json: text ? JSON.parse(text) : null }
}

/**
 * The same over a bare socket, for what `fetch` will not send: a `Host` of the
 * caller's choosing, or a `Content-Length` the body does not keep. `body` is
 * written and the request left open, so an answer that arrives proves the
 * server did not wait for the rest.
 */
async function rawCall(
  client: Client,
  method: string,
  path: string,
  headers: Record<string, string>,
  body = '',
): Promise<{ status: number, json: { code: string } }> {
  const url = new URL(path, client.server.url)
  return await new Promise((resolve, reject) => {
    const request = httpRequest({ host: url.hostname, port: url.port, method, path: url.pathname + url.search, headers }, (response) => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => {
        text += chunk
      })
      response.on('end', () => resolve({ status: response.statusCode ?? 0, json: JSON.parse(text) }))
      response.on('error', reject)
    })
    request.on('error', reject)
    request.write(body)
    if (!headers['content-length']) {
      request.end()
    }
  })
}

describe.each(BOARD_STORE_FACTORIES)('kanbo serve on $name', (factory) => {
  let board: TestBoardStore
  let client: Client

  async function start(options: Partial<KanboServeOptions> = {}): Promise<Client> {
    const server = await startKanboServer({
      session: sessionOn(board.store),
      actors: PERSON_ACTORS,
      host: '127.0.0.1',
      port: 0,
      token: TOKEN,
      ...options,
    })
    return { server, token: options.token === undefined ? TOKEN : options.token ?? undefined }
  }

  beforeEach(async () => {
    board = await factory.open([{ id: WORKSPACE.id, identifier: WORKSPACE.identifier }, { id: OTHER_WORKSPACE.id, identifier: 'OTH' }])
    client = await start()
  })

  afterEach(async () => {
    await client.server.close()
    await board.dispose()
  })

  /** Start the test over on a server started some other way. */
  async function restart(options: Partial<KanboServeOptions>): Promise<void> {
    await client.server.close()
    client = await start(options)
  }

  /** A card waiting for a person, as `WOR-001`. */
  async function waitingCard(): Promise<void> {
    await call(client, 'POST', '/issues', { body: { workspaceId: WORKSPACE.id, title: 'Needs a person' } })
    expect((await call(client, 'POST', '/issues/WOR-001/wait-approval', { body: { statusLine: 'look at this' } })).status).toBe(200)
  }

  it('lists a card it created with every field a card view carries', async () => {
    const created = await call(client, 'POST', '/issues/', {
      body: { workspaceId: WORKSPACE.id, title: 'Ship the server', statusName: 'in_progress', executionMode: 'main' },
    })
    expect(created.status).toBe(200)
    expect(created.json).toMatchObject({ id: 'WOR-001', title: 'Ship the server', executionMode: 'main', createdByKind: 'system' })

    const run = await call(client, 'POST', '/issues/WOR-001/runs', { body: { agentName: 'claude' } })
    expect(run.json).toMatchObject({ issueId: 'WOR-001', attempt: 1, state: 'running' })
    await call(client, 'PATCH', '/issues/WOR-001/status-line', { body: { statusLine: 'writing the routes' } })

    const listed = await call(client, 'GET', `/issues?workspaceId=${WORKSPACE.id}`)
    expect(listed.status).toBe(200)
    expect(listed.json).toHaveLength(1)
    const [card] = listed.json
    expect(card).toMatchObject({
      id: 'WOR-001',
      statusLine: 'writing the routes',
      waitingFor: null,
      executionMode: 'main',
      labels: [],
      attemptCount: 1,
      activeRun: { id: run.json.id, agentName: 'claude', state: 'running', executionMode: 'main' },
    })
    expect(Object.keys(card).sort()).toEqual(Object.keys(ISSUE_VIEW_FIELDS).sort())
  })

  it('moves the board version on a move, a status line and a comment', async () => {
    await call(client, 'POST', '/issues', { body: { workspaceId: WORKSPACE.id, title: 'Watch me' } })
    const version = async (): Promise<number> => (await call(client, 'GET', `/issues/version?workspaceId=${WORKSPACE.id}`)).json.seq

    const beforeMove = await version()
    expect((await call(client, 'PATCH', '/issues/WOR-001/status/in-progress')).status).toBe(200)
    const beforeLine = await version()
    expect(beforeLine).toBeGreaterThan(beforeMove)

    expect((await call(client, 'PATCH', '/issues/WOR-001/status-line', { body: { statusLine: 'on it' } })).status).toBe(200)
    const beforeComment = await version()
    expect(beforeComment).toBeGreaterThan(beforeLine)

    const comment = await call(client, 'POST', '/issues/WOR-001/comments', { body: { content: 'halfway' } })
    expect(comment.json).toMatchObject({ content: 'halfway', author: { kind: 'system', displayName: 'tester', label: 'External' } })
    expect(await version()).toBeGreaterThan(beforeComment)
  })

  it('answers a board failure with the status and body the error table names', async () => {
    const missing = await call(client, 'GET', '/issues/WOR-404')
    expect(missing.status).toBe(404)
    expect(missing.json).toEqual({ code: 'issue_not_found', message: 'Issue not found', details: { issueId: 'WOR-404' } })

    await waitingCard()
    const asAgent = await call(client, 'POST', '/issues/WOR-001/approve', { body: {}, headers: { 'x-kanbo-actor': 'agent' } })
    expect(asAgent.status).toBe(403)
    expect(asAgent.json).toMatchObject({ code: 'issue_approval_requires_user', message: 'Only a person can approve a card' })

    const returned = await call(client, 'POST', '/issues/WOR-001/return', { body: { comment: 'no' }, headers: { 'x-kanbo-actor': 'agent' } })
    expect(returned.status).toBe(403)
    expect(returned.json.code).toBe('issue_return_requires_user')
  })

  it('reads the agent header among several values, however spelled', async () => {
    await waitingCard()
    const approved = await call(client, 'POST', '/issues/WOR-001/approve', { body: {}, headers: { 'x-kanbo-actor': 'external, Agent ' } })
    expect(approved.status).toBe(403)
    const repeated = await call(client, 'POST', '/issues/WOR-001/approve', { body: {}, headers: { 'x-kanbo-actor': 'agent, agent' } })
    expect(repeated.status).toBe(403)
    expect(repeated.json.code).toBe('issue_approval_requires_user')
  })

  it('acts for a person only for a request holding the token', async () => {
    await waitingCard()
    expect((await call(client, 'POST', '/issues/WOR-001/approve', { body: { comment: 'fine' } })).json.waitingFor).toBeNull()

    await restart({ token: null })
    await call(client, 'POST', '/issues/WOR-001/wait-approval', { body: {} })
    const tokenless = await call(client, 'POST', '/issues/WOR-001/approve', { body: {} })
    expect(tokenless.status).toBe(403)
    expect(tokenless.json.code).toBe('issue_approval_requires_user')
  })

  it('refuses a person\'s operations to an agent: closing a sprint and deleting what the board wrote', async () => {
    const sprint = await call(client, 'POST', '/issues/milestones', { body: { workspaceId: WORKSPACE.id, title: 'Sprint 1' } })
    const closed = await call(client, 'POST', `/issues/milestones/${sprint.json.id}/close`, { body: {}, headers: { 'x-kanbo-actor': 'agent' } })
    expect(closed.status).toBe(403)
    expect(closed.json.code).toBe('issue_sprint_close_requires_user')

    await waitingCard()
    await call(client, 'POST', '/issues/WOR-001/approve', { body: { comment: 'fine' } })
    const decision = (await call(client, 'GET', '/issues/WOR-001/comments')).json.find((comment: { authorKind: string }) => comment.authorKind === 'system.approved')
    const deleted = await call(client, 'DELETE', `/issues/comments/${decision.id}`, { headers: { 'x-kanbo-actor': 'agent' } })
    expect(deleted.status).toBe(403)
    expect(deleted.json.code).toBe('issue_comment_delete_requires_user')
  })

  it('deletes a card only for a person', async () => {
    await call(client, 'POST', '/issues', { body: { workspaceId: WORKSPACE.id, title: 'Delete me' } })

    const asAgent = await call(client, 'DELETE', '/issues/WOR-001', { headers: { 'x-kanbo-actor': 'agent' } })
    expect(asAgent.status).toBe(403)
    expect(asAgent.json).toMatchObject({ code: 'issue_delete_requires_user', details: { issueId: 'WOR-001' } })
    expect(await board.store.issues.findById('WOR-001')).not.toBeNull()

    expect((await call(client, 'DELETE', '/issues/WOR-001')).json).toEqual({ ok: true })
    expect(await board.store.issues.findById('WOR-001')).toBeNull()
  })

  describe('column changes, a person\'s to make', () => {
    /** The columns, seeded by a first card, by slug. */
    async function columnsBySlug(): Promise<Record<string, { id: string, name: string, order: number }>> {
      const listed = (await call(client, 'GET', `/issues/statuses?workspaceId=${WORKSPACE.id}`)).json as { id: string, name: string, order: number }[]
      return Object.fromEntries(listed.map(column => [column.name.toLowerCase().replace(/\W+/g, '_'), column]))
    }

    beforeEach(async () => {
      await call(client, 'POST', '/issues', { body: { workspaceId: WORKSPACE.id, title: 'Seeds the columns', statusName: 'in_review' } })
    })

    it('refuses every column change to an agent, and to a request without the token', async () => {
      const columns = await columnsBySlug()
      const ids = Object.values(columns).map(column => column.id)
      const attempts = (headers: Record<string, string>) => [
        call(client, 'POST', '/issues/statuses', { body: { workspaceId: WORKSPACE.id, name: 'QA' }, headers }),
        call(client, 'PATCH', `/issues/statuses/${columns.done!.id}`, { body: { name: 'Shipped' }, headers }),
        call(client, 'DELETE', `/issues/statuses/${columns.canceled!.id}`, { headers }),
        call(client, 'POST', '/issues/statuses/reorder', { body: { workspaceId: WORKSPACE.id, orderedIds: ids.toReversed() }, headers }),
        call(client, 'POST', '/issues/statuses/standard', { body: { workspaceId: WORKSPACE.id }, headers }),
      ]

      for (const answer of await Promise.all(attempts({ 'x-kanbo-actor': 'agent' }))) {
        expect(answer.status).toBe(403)
        expect(answer.json.code).toBe('issue_column_structure_requires_user')
      }
      await restart({ token: null })
      for (const answer of await Promise.all(attempts({}))) {
        expect(answer.status).toBe(403)
        expect(answer.json.code).toBe('issue_column_structure_requires_user')
      }
      expect(await columnsBySlug()).toEqual(columns)
    })

    it('keeps To Do: a rename away from its slug and a delete are refused', async () => {
      const { to_do: toDo } = await columnsBySlug()

      const renamed = await call(client, 'PATCH', `/issues/statuses/${toDo!.id}`, { body: { name: 'Ready' } })
      expect(renamed.status).toBe(400)
      expect(renamed.json.code).toBe('board_column_ready_protected')
      const deleted = await call(client, 'DELETE', `/issues/statuses/${toDo!.id}`)
      expect(deleted.status).toBe(400)
      expect(deleted.json.code).toBe('board_column_ready_protected')
      expect((await call(client, 'PATCH', `/issues/statuses/${toDo!.id}`, { body: { name: 'To-do' } })).json.name).toBe('To-do')
    })

    it('deletes a column holding cards only when told where they go, in the body or the query', async () => {
      const { in_review: inReview, done } = await columnsBySlug()

      const refused = await call(client, 'DELETE', `/issues/statuses/${inReview!.id}`)
      expect(refused.status).toBe(409)
      expect(refused.json).toMatchObject({ code: 'board_column_not_empty', details: { cardCount: 1 } })
      expect((await call(client, 'GET', '/issues/WOR-001')).json.statusId).toBe(inReview!.id)

      const removed = await call(client, 'DELETE', `/issues/statuses/${inReview!.id}`, { body: { moveCardsTo: 'done' } })
      expect(removed.json).toEqual({ ok: true, movedCards: 1 })
      expect((await call(client, 'GET', '/issues/WOR-001')).json.statusId).toBe(done!.id)

      const { backlog } = await columnsBySlug()
      await call(client, 'PATCH', '/issues/WOR-001/status/backlog')
      const byQuery = await call(client, 'DELETE', `/issues/statuses/${backlog!.id}?moveCardsTo=to_do`)
      expect(byQuery.json).toEqual({ ok: true, movedCards: 1 })
      expect(Object.values(await columnsBySlug()).map(column => column.order)).toEqual([0, 1, 2, 3])
    })
  })

  it('refuses approval to every request when the server was started from an agent\'s shell', async () => {
    await restart({ actors: { ...PERSON_ACTORS, person: null } })
    await waitingCard()

    const approved = await call(client, 'POST', '/issues/WOR-001/approve', { body: {} })
    expect(approved.status).toBe(403)
    expect(approved.json.code).toBe('issue_approval_requires_user')
  })

  it('reaches no workspace but its own', async () => {
    const ops = createBoardOps(board.store)
    const foreign = await ops.createCard({ workspace: OTHER_WORKSPACE, title: 'Not yours' }, PERSON_ACTORS.writer)
    const comment = await ops.addComment({ issueId: foreign.id, content: 'theirs' }, PERSON_ACTORS.writer)
    const run = await ops.startRun(foreign.id, { agentName: 'claude' }, PERSON_ACTORS.writer)

    const read = await call(client, 'GET', `/issues/${foreign.id}`)
    expect(read.status).toBe(404)
    expect(read.json.code).toBe('issue_not_found')
    expect((await call(client, 'DELETE', `/issues/${foreign.id}`)).status).toBe(404)
    expect(await board.store.issues.findById(foreign.id)).not.toBeNull()

    const commentDelete = await call(client, 'DELETE', `/issues/comments/${comment.id}`)
    expect(commentDelete.status).toBe(404)
    expect(commentDelete.json.code).toBe('issue_comment_not_found')
    const runFinish = await call(client, 'PATCH', `/issues/runs/${run.id}`, { body: { state: 'finished' } })
    expect(runFinish.status).toBe(404)
    expect(runFinish.json.code).toBe('board_run_not_found')
    expect((await board.store.runs.findById(run.id))?.state).toBe('running')

    const listed = await call(client, 'GET', `/issues?workspaceId=${OTHER_WORKSPACE.id}`)
    expect(listed.status).toBe(404)
    expect(listed.json).toMatchObject({ code: 'issue_workspace_not_found', details: { workspaceId: OTHER_WORKSPACE.id } })
    expect((await call(client, 'GET', '/issues')).json).toEqual([])
  })

  it('answers no workspaces with no columns', async () => {
    const empty = await call(client, 'GET', '/issues/columns?workspaceIds=')
    expect(empty.status).toBe(200)
    expect(empty.json).toEqual([])
    expect((await call(client, 'GET', `/issues/columns?workspaceIds=${WORKSPACE.id}`)).json.length).toBeGreaterThan(0)
  })
})

describe('kanbo serve at the door', () => {
  let board: TestBoardStore
  const servers: RunningKanboServer[] = []

  beforeEach(async () => {
    board = await BOARD_STORE_FACTORIES[0].open([{ id: WORKSPACE.id, identifier: WORKSPACE.identifier }])
  })

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await server.close()
    }
    await board.dispose()
  })

  async function start(options: Partial<KanboServeOptions> = {}): Promise<Client> {
    const server = await startKanboServer({
      session: sessionOn(board.store),
      actors: PERSON_ACTORS,
      host: '127.0.0.1',
      port: 0,
      ...options,
    })
    servers.push(server)
    return { server, token: options.token ?? undefined }
  }

  it('answers an invalid body with 400 and says what is wrong', async () => {
    const client = await start()
    const invalid = await call(client, 'POST', '/issues', { body: { workspaceId: WORKSPACE.id, priority: 'whenever' } })
    expect(invalid.status).toBe(400)
    expect(invalid.json).toMatchObject({
      code: 'validation_error',
      message: 'request validation failed',
      details: { source: 'body', issues: [{ path: 'priority' }] },
    })

    const notJson = await call(client, 'POST', '/issues', { rawBody: '{"workspaceId":' })
    expect(notJson.status).toBe(400)
    expect(notJson.json.code).toBe('validation_error')
  })

  it('takes a write only as JSON', async () => {
    const client = await start()
    const plain = await call(client, 'POST', '/issues', {
      rawBody: JSON.stringify({ workspaceId: WORKSPACE.id, title: 'From a form' }),
      headers: { 'content-type': 'text/plain' },
    })
    expect(plain.status).toBe(415)
    expect(plain.json.code).toBe('unsupported_media_type')
    expect(await board.store.issues.listByWorkspace(WORKSPACE.id)).toEqual([])

    const charset = await call(client, 'POST', '/issues', {
      body: { workspaceId: WORKSPACE.id, title: 'As JSON' },
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })
    expect(charset.status).toBe(200)
  })

  it('refuses a body over the limit with 413 and writes nothing', async () => {
    const client = await start()
    const oversized = await rawCall(client, 'POST', '/issues', { 'content-type': 'application/json', 'host': hostOf(client) }, JSON.stringify({
      workspaceId: WORKSPACE.id,
      title: 'big',
      description: 'x'.repeat(SERVE_BODY_LIMIT_BYTES),
    }))
    expect(oversized.status).toBe(413)
    expect(oversized.json.code).toBe('payload_too_large')
    expect(await board.store.issues.listByWorkspace(WORKSPACE.id)).toEqual([])
  })

  it('refuses a body that says it is over the limit without reading it', async () => {
    const client = await start()
    // Two bytes of a body declared at twice the limit, and the request left
    // open: only a server that answers before reading the rest answers at all.
    const declared = await rawCall(client, 'POST', '/issues', {
      'content-type': 'application/json',
      'content-length': String(SERVE_BODY_LIMIT_BYTES * 2),
      'host': hostOf(client),
    }, '{"')
    expect(declared.status).toBe(413)
    expect(declared.json.code).toBe('payload_too_large')
  })

  it('answers only to its own loopback name', async () => {
    const client = await start()
    const rebound = await rawCall(client, 'GET', '/issues', { host: `attacker.example:${client.server.port}` })
    expect(rebound.status).toBe(403)
    expect(rebound.json.code).toBe('host_not_allowed')
    const otherPort = await rawCall(client, 'GET', '/issues', { host: `localhost:${client.server.port + 1}` })
    expect(otherPort.status).toBe(403)
    expect((await rawCall(client, 'GET', '/issues', { host: `localhost:${client.server.port}` })).status).toBe(200)
  })

  it('lets in only a request carrying the token', async () => {
    const client = await start({ token: TOKEN })
    const path = `/issues/version?workspaceId=${WORKSPACE.id}`

    const missing = await call({ server: client.server }, 'GET', path)
    expect(missing.status).toBe(401)
    expect(missing.json.code).toBe('unauthorized')
    expect((await call({ server: client.server, token: 'wrong-token' }, 'GET', path)).status).toBe(401)
    expect((await call(client, 'GET', path)).status).toBe(200)

    const unknownPath = await call({ server: client.server }, 'GET', '/nothing/here')
    expect(unknownPath.status).toBe(401)
  })

  it('refuses to start beyond this machine without a token', async () => {
    await expect(start({ host: '0.0.0.0' })).rejects.toThrow(SERVE_TOKEN_REQUIRED_MESSAGE)
    const guarded = await start({ host: '0.0.0.0', token: TOKEN })
    expect(guarded.server.port).toBeGreaterThan(0)
  })

  it('listens on an IPv6 loopback written as a URL writes it', async () => {
    const client = await start({ host: '[::1]' })
    expect(client.server.url).toBe(`http://[::1]:${client.server.port}`)
    expect((await call(client, 'GET', '/issues')).status).toBe(200)
  })

  it('refuses every origin not on the list, and names only the listed one', async () => {
    const origin = 'https://board.example'
    const closed = await start()
    const unlisted = await call(closed, 'GET', '/issues', { headers: { origin } })
    expect(unlisted.status).toBe(403)
    expect(unlisted.json.code).toBe('origin_not_allowed')
    expect(unlisted.headers.get('access-control-allow-origin')).toBeNull()
    expect((await call(closed, 'GET', '/issues')).status).toBe(200)

    const open = await start({ corsOrigins: [origin], token: TOKEN })
    const allowed = await call(open, 'GET', '/issues', { headers: { origin } })
    expect(allowed.status).toBe(200)
    expect(allowed.headers.get('access-control-allow-origin')).toBe(origin)
    const other = await call(open, 'POST', '/issues', { body: { workspaceId: WORKSPACE.id }, headers: { origin: 'https://evil.example' } })
    expect(other.status).toBe(403)
    expect(other.json.code).toBe('origin_not_allowed')
    expect(await board.store.issues.listByWorkspace(WORKSPACE.id)).toEqual([])

    // A preflight carries no token, and is answered anyway — with the allow
    // headers for a listed origin only.
    const preflightHeaders = { 'access-control-request-method': 'PATCH', 'access-control-request-headers': 'authorization' }
    const preflight = await call({ server: open.server }, 'OPTIONS', '/issues', { headers: { origin, ...preflightHeaders } })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe(origin)
    expect(preflight.headers.get('access-control-allow-methods')).toContain('PATCH')
    expect(preflight.headers.get('access-control-allow-headers')).toContain('authorization')
    const unlistedPreflight = await call({ server: open.server }, 'OPTIONS', '/issues', { headers: { origin: 'https://evil.example', ...preflightHeaders } })
    expect(unlistedPreflight.headers.get('access-control-allow-origin')).toBeNull()
    expect(unlistedPreflight.headers.get('access-control-allow-methods')).toBeNull()
    expect(unlistedPreflight.headers.get('access-control-allow-headers')).toBeNull()
  })
})

describe('kanbo serve\'s board page', () => {
  let board: TestBoardStore
  let pageDirectory: string
  const servers: RunningKanboServer[] = []

  beforeEach(async () => {
    board = await BOARD_STORE_FACTORIES[0].open([{ id: WORKSPACE.id, identifier: WORKSPACE.identifier }])
    // The built page stands in for `dist/page/`, so this runs without a build;
    // `src/dist-alone.test.ts` asks the real one.
    pageDirectory = mkdtempSync(join(tmpdir(), 'kanbo-page-'))
    writeFileSync(join(pageDirectory, 'board.js'), 'console.log("board")')
    writeFileSync(join(pageDirectory, 'board.css'), 'body{}')
  })

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await server.close()
    }
    await board.dispose()
    rmSync(pageDirectory, { recursive: true, force: true })
  })

  async function start(options: Partial<KanboServeOptions> = {}): Promise<Client> {
    const server = await startKanboServer({
      session: sessionOn(board.store),
      actors: PERSON_ACTORS,
      host: '127.0.0.1',
      port: 0,
      token: TOKEN,
      pageDirectory,
      ...options,
    })
    servers.push(server)
    return { server, token: TOKEN }
  }

  async function fetchPage(client: Client, path: string): Promise<{ status: number, headers: Headers, text: string }> {
    const response = await fetch(`${client.server.url}${path}`)
    return { status: response.status, headers: response.headers, text: await response.text() }
  }

  it('serves the page and its assets without the token, under a policy that lets it load only itself', async () => {
    const client = await start()
    const page = await fetchPage(client, '/')
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(page.headers.get('content-security-policy')).toBe(
      'default-src \'none\'; script-src \'self\'; style-src \'self\'; connect-src \'self\'; img-src \'self\' data:; '
      + 'base-uri \'none\'; form-action \'none\'; frame-ancestors \'none\'',
    )
    expect(page.headers.get('x-content-type-options')).toBe('nosniff')
    expect(page.headers.get('referrer-policy')).toBe('no-referrer')
    expect(page.headers.get('cache-control')).toBe('no-cache')
    expect(page.text).toContain('<script src="/assets/board.js" defer></script>')
    expect(page.text).toContain('<link rel="stylesheet" href="/assets/board.css">')

    const script = await fetchPage(client, '/assets/board.js')
    expect(script.status).toBe(200)
    expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(script.text).toBe('console.log("board")')
    const stylesheet = await fetchPage(client, '/assets/board.css')
    expect(stylesheet.headers.get('content-type')).toBe('text/css; charset=utf-8')
    expect(stylesheet.text).toBe('body{}')

    // The page is open; the board behind it is not.
    const cards = await call({ server: client.server }, 'GET', '/issues')
    expect(cards.status).toBe(401)
    expect((await fetchPage(client, '/assets/other.js')).status).toBe(401)
  })

  it('says how to build the page when it is not built', async () => {
    const client = await start({ pageDirectory: join(pageDirectory, 'missing') })
    const page = await fetchPage(client, '/')
    expect(page.status).toBe(404)
    expect(page.text).toContain('npm run build')
  })

  it('takes a write from its own page\'s origin, and still no other', async () => {
    const client = await start()
    const port = client.server.port
    const body = { workspaceId: WORKSPACE.id, description: 'From the page' }

    const own = await call(client, 'POST', '/issues', { body, headers: { origin: `http://127.0.0.1:${port}` } })
    expect(own.status).toBe(200)
    // Same origin: nothing for CORS to say.
    expect(own.headers.get('access-control-allow-origin')).toBeNull()
    expect((await call(client, 'PATCH', `/issues/${own.json.id}/status/in_progress`, { headers: { origin: `http://localhost:${port}` } })).status).toBe(200)

    for (const origin of ['http://evil.example', `http://127.0.0.1:${port + 1}`, `https://127.0.0.1:${port}`]) {
      const foreign = await call(client, 'POST', '/issues', { body, headers: { origin } })
      expect(foreign.status).toBe(403)
      expect(foreign.json.code).toBe('origin_not_allowed')
    }
    // Its own origin passes the door, not the token.
    const tokenless = await call({ server: client.server }, 'POST', '/issues', { body, headers: { origin: `http://127.0.0.1:${port}` } })
    expect(tokenless.status).toBe(401)
    expect(await board.store.issues.listByWorkspace(WORKSPACE.id)).toHaveLength(1)
  })
})

/** The `Host` a client of this server sends. */
function hostOf(client: Client): string {
  return new URL(client.server.url).host
}

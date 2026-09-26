import { afterEach, describe, expect, it, vi } from 'vitest'

import type { BoardSession } from '../cli/command'
import { createBoardOps } from '../ops'
import type { TestBoardStore } from '../testing/board-stores'
import { BOARD_STORE_FACTORIES } from '../testing/board-stores'
import type { ServeAccess, ServePagePresentation } from './access'
import { presentServePage, resolveServeAccess } from './access'
import type { RunningKanboServer } from './server'
import { SERVE_TOKEN_REQUIRED_MESSAGE, startKanboServer } from './server'

const WORKSPACE = { id: 'workspace', identifier: 'WOR', name: 'Workspace' }
const URL_BASE = 'http://127.0.0.1:4318'

/** What `presentServePage` printed and opened, for one presentation. */
function present(access: ServeAccess, presentation: Partial<ServePagePresentation> = {}) {
  const printed: string[] = []
  const openInBrowser = vi.fn()
  presentServePage(
    { url: URL_BASE, access, agentShell: false, terminal: true, open: true, ...presentation },
    { print: line => printed.push(line), openInBrowser },
  )
  return { printed: printed.join('\n'), openInBrowser }
}

describe('the token kanbo serve guards the board with', () => {
  it('is made up for a loopback server nobody gave one, differently every run', () => {
    const first = resolveServeAccess('127.0.0.1', null)
    const second = resolveServeAccess('localhost', null)
    expect(first.generated).toBe(true)
    expect(first.token).toMatch(/^[\w-]{32}$/)
    expect(second.token).not.toBe(first.token)
  })

  it('is the one given when there is one, and is still required off loopback', () => {
    expect(resolveServeAccess('127.0.0.1', 'mine')).toEqual({ token: 'mine', generated: false })
    expect(() => resolveServeAccess('0.0.0.0', null)).toThrow(SERVE_TOKEN_REQUIRED_MESSAGE)
  })
})

describe('handing the person the board page', () => {
  it('prints and opens a link carrying a generated token in its fragment', () => {
    const access = resolveServeAccess('127.0.0.1', null)
    const { printed, openInBrowser } = present(access)
    expect(printed).toBe(`kanbo serve: board page ${URL_BASE}/#token=${access.token}`)
    expect(openInBrowser).toHaveBeenCalledExactlyOnceWith(`${URL_BASE}/#token=${access.token}`)
  })

  it('never repeats a token the person gave', () => {
    const { printed, openInBrowser } = present({ token: 'mine', generated: false })
    expect(printed).toBe(`kanbo serve: board page ${URL_BASE}/`)
    expect(printed).not.toContain('#token=')
    expect(openInBrowser).toHaveBeenCalledExactlyOnceWith(`${URL_BASE}/`)
  })

  it('only prints the link under --no-open', () => {
    const { printed, openInBrowser } = present(resolveServeAccess('127.0.0.1', null), { open: false })
    expect(printed).toContain('#token=')
    expect(openInBrowser).not.toHaveBeenCalled()
  })

  it.each([
    ['an agent\'s shell', { agentShell: true }],
    ['output that is not a terminal', { terminal: false }],
  ])('hands %s neither the token nor a browser', (_name, presentation) => {
    const access = resolveServeAccess('127.0.0.1', null)
    const { printed, openInBrowser } = present(access, presentation)
    expect(printed).not.toContain(access.token)
    expect(printed).toContain('KANBO_SERVE_TOKEN')
    expect(openInBrowser).not.toHaveBeenCalled()
  })
})

describe.each(BOARD_STORE_FACTORIES)('a server started with a generated token on $name', (factory) => {
  let board: TestBoardStore
  let server: RunningKanboServer

  afterEach(async () => {
    await server.close()
    await board.dispose()
  })

  it('turns away a request without the printed token and answers one with it', async () => {
    board = await factory.open([{ id: WORKSPACE.id, identifier: WORKSPACE.identifier }])
    const access = resolveServeAccess('127.0.0.1', null)
    const session: BoardSession = { ops: createBoardOps(board.store), store: board.store, workspace: WORKSPACE, assertWritable: async () => {} }
    server = await startKanboServer({
      session,
      actors: { writer: { kind: 'external', id: 'tester', name: 'test-host' }, person: { kind: 'user', id: 'tester' } },
      host: '127.0.0.1',
      port: 0,
      token: access.token,
    })
    const { printed } = present(access, { url: server.url })
    const printedToken = /#token=(\S+)$/.exec(printed)?.[1]

    const path = `${server.url}/issues?workspaceId=${WORKSPACE.id}`
    expect((await fetch(path)).status).toBe(401)
    expect((await fetch(path, { headers: { authorization: `Bearer ${printedToken}` } })).status).toBe(200)
  })
})

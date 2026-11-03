import { describe, expect, it } from 'vitest'

import type { KanboBinding } from '../cli/binding'
import type { OpenBoardSession } from '../cli/command'
import type { RegisteredProject } from '../cli/project-registry'
import { createBoardOps } from '../ops'
import { BOARD_STORE_FACTORIES } from '../testing/board-stores'
import { createServeProjects } from './projects'

const [factory] = BOARD_STORE_FACTORIES
const DIR_A = '/work/app-a'
const DIR_B = '/work/app-b'
const DIR_PG = '/work/shared'
const PASSWORD = 'hunter2-secret'

function binding(extra: Partial<KanboBinding> = {}): KanboBinding {
  return { schemaVersion: 1, workspaceId: 'w', ...extra }
}

async function setup(options: { bindings?: Record<string, KanboBinding | null>, registry?: string[], failOpen?: () => boolean } = {}) {
  const board = await factory.open([{ id: 'w', identifier: 'WOR' }])
  const calls: string[] = []
  const closed: string[] = []
  const makeSession = (label: string): OpenBoardSession => ({
    ops: createBoardOps(board.store),
    store: board.store,
    workspace: { id: 'w', identifier: 'WOR', name: 'W' },
    assertWritable: async () => {},
    close: async () => {
      closed.push(label)
    },
  })
  const bindings = options.bindings ?? { [DIR_A]: binding(), [DIR_B]: binding() }
  const projects = createServeProjects({
    defaultProject: { dir: DIR_A, session: makeSession('default') },
    readRegistry: () => (options.registry ?? [DIR_B, DIR_A]).map((path): RegisteredProject => ({ path, lastSeenAt: 1 })),
    readBinding: dir => bindings[dir] ?? null,
    openSession: async (dir) => {
      calls.push(dir)
      if (options.failOpen?.()) {
        throw new Error('board is gone')
      }
      return makeSession(dir)
    },
  })
  return { projects, calls, closed, board }
}

describe('createServeProjects', () => {
  it('lists the registry projects with stable ids, the default first and flagged', async () => {
    const { projects, board } = await setup()
    const list = projects.list()
    expect(list.map(project => project.folder)).toEqual([DIR_A, DIR_B])
    expect(list.map(project => project.isDefault)).toEqual([true, false])
    expect(list[0].id).toMatch(/^[0-9a-f]{12}$/)
    expect(projects.list()).toEqual(list)
    await board.dispose()
  })

  it('lists the default project even when the registry does not hold it', async () => {
    const { projects, board } = await setup({ registry: [DIR_B] })
    expect(projects.list().map(project => project.folder)).toEqual([DIR_A, DIR_B])
    await board.dispose()
  })

  it('does not list a project whose binding is gone', async () => {
    const { projects, board } = await setup({ bindings: { [DIR_A]: binding(), [DIR_B]: null } })
    expect(projects.list().map(project => project.folder)).toEqual([DIR_A])
    await board.dispose()
  })

  it('shows a Postgres project by its host, without the password or the scheme', async () => {
    const url = `postgres://kanbo:${PASSWORD}@db.example.com:5432/board?sslmode=require`
    const { projects, board } = await setup({
      bindings: { [DIR_A]: binding(), [DIR_PG]: binding({ databaseUrl: url }) },
      registry: [DIR_PG],
    })
    const view = projects.list().find(project => project.folder === DIR_PG)
    expect(view?.storage).toEqual({ kind: 'postgres', where: 'db.example.com:5432' })
    const text = JSON.stringify(projects.list())
    expect(text).not.toContain(PASSWORD)
    expect(text).not.toContain('postgres://')
    await board.dispose()
  })

  it('opens a project once, however many times it is resolved', async () => {
    const { projects, calls, board } = await setup()
    const id = projects.list()[1].id
    const first = await projects.resolve(id)
    expect(await projects.resolve(id)).toBe(first)
    expect(calls).toEqual([DIR_B])
    await board.dispose()
  })

  it('answers the default project from the session it was given, without opening it', async () => {
    const { projects, calls, board } = await setup()
    await projects.resolve(projects.list()[0].id)
    expect(calls).toEqual([])
    await board.dispose()
  })

  it('refuses an unknown id as project_not_found', async () => {
    const { projects, board } = await setup()
    await expect(projects.resolve('nope')).rejects.toMatchObject({ status: 404, code: 'project_not_found' })
    await board.dispose()
  })

  it('answers project_unavailable when a board will not open, and tries again next time', async () => {
    let failing = true
    const { projects, calls, board } = await setup({ failOpen: () => failing })
    const id = projects.list()[1].id
    await expect(projects.resolve(id)).rejects.toMatchObject({ status: 503, code: 'project_unavailable' })
    failing = false
    await projects.resolve(id)
    expect(calls).toEqual([DIR_B, DIR_B])
    await board.dispose()
  })

  it('closes every session it opened and not the default one', async () => {
    const { projects, closed, board } = await setup()
    await projects.resolve(projects.list()[0].id)
    await projects.resolve(projects.list()[1].id)
    await projects.close()
    expect(closed).toEqual([DIR_B])
    await board.dispose()
  })
})

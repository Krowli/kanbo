import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

import type { BoardSession, OpenBoardSession } from '../cli/command'
import type { KanboBinding } from '../cli/binding'
import { describeFailure } from '../cli/failure'
import type { RegisteredProject } from '../cli/project-registry'
import { tildify } from '../cli/tildify'
import { maskDatabaseUrl } from '../domain/database-url'
import { ServeError } from './errors'
import type { Route } from './router'
import { createIssueRoutes } from './routes'

/**
 * The projects one `kanbo serve` offers: the one it was started for, and every
 * other folder kanbo has opened a board in (`~/.kanbo/projects.json`). A
 * project's board is opened the first time a request asks for it and stays
 * open until the server stops.
 */

/** A project as the page lists it. Never carries a connection string. */
export interface ServeProjectView {
  /** First 12 hex chars of sha256(path): stable across restarts, keeps the path out of URLs. */
  id: string
  /** Folder name — the label until the board says its own name. */
  name: string
  /** `~/…` form of the folder. */
  folder: string
  storage: { kind: 'file', path: string } | { kind: 'postgres', where: string }
  /** The project `kanbo serve` was started for — what the bare `/issues` routes answer. */
  isDefault: boolean
}

export interface ServeProjects {
  list: () => ServeProjectView[]
  /** The open session and routes for a project id; opens it the first time. 404 `project_not_found` for an unknown id. */
  resolve: (projectId: string) => Promise<{ session: BoardSession, routes: Route[] }>
  /** Close every session this opened (not the default one — its owner closes it). */
  close: () => Promise<void>
}

export function createServeProjects(input: {
  defaultProject: { dir: string, session: BoardSession } | null
  readRegistry: () => RegisteredProject[]
  readBinding: (dir: string) => KanboBinding | null
  openSession: (dir: string) => Promise<OpenBoardSession>
}): ServeProjects {
  const opened = new Map<string, { session: OpenBoardSession, routes: Route[] }>()
  let defaultOpened: { session: BoardSession, routes: Route[] } | null = null

  /** Every project that can be offered right now, default first, with the folder each lives in. */
  function entries(): { view: ServeProjectView, dir: string }[] {
    const defaultDir = input.defaultProject?.dir ?? null
    const dirs = [
      ...(defaultDir === null ? [] : [defaultDir]),
      ...input.readRegistry().map(project => project.path).filter(path => path !== defaultDir),
    ]
    const found: { view: ServeProjectView, dir: string }[] = []
    for (const dir of dirs) {
      const binding = input.readBinding(dir)
      if (binding === null && dir !== defaultDir) {
        continue
      }
      found.push({ view: viewOf(dir, binding, dir === defaultDir), dir })
    }
    return found
  }

  return {
    list: () => entries().map(entry => entry.view),
    resolve: async (projectId) => {
      const entry = entries().find(candidate => candidate.view.id === projectId)
      if (!entry) {
        throw new ServeError(404, 'project_not_found', 'No project with that id is on this computer\'s list')
      }
      if (entry.view.isDefault && input.defaultProject) {
        defaultOpened ??= { session: input.defaultProject.session, routes: createIssueRoutes(input.defaultProject.session) }
        return defaultOpened
      }
      const cached = opened.get(projectId)
      if (cached) {
        return cached
      }
      let session: OpenBoardSession
      try {
        session = await input.openSession(entry.dir)
      }
      catch (error) {
        throw new ServeError(503, 'project_unavailable', describeFailure(error).message)
      }
      const project = { session, routes: createIssueRoutes(session) }
      opened.set(projectId, project)
      return project
    },
    close: async () => {
      const sessions = [...opened.values()].map(project => project.session)
      opened.clear()
      await Promise.allSettled(sessions.map(async session => await session.close()))
    },
  }
}

function projectId(dir: string): string {
  return createHash('sha256').update(dir).digest('hex').slice(0, 12)
}

function viewOf(dir: string, binding: KanboBinding | null, isDefault: boolean): ServeProjectView {
  return {
    id: projectId(dir),
    name: dir.split(/[\\/]/).filter(Boolean).pop() ?? dir,
    folder: tildify(dir),
    storage: storageOf(dir, binding),
    isDefault,
  }
}

/** Where the board lives. The connection string is read here to name its host, and goes no further. */
function storageOf(dir: string, binding: KanboBinding | null): ServeProjectView['storage'] {
  if (binding?.databaseUrl) {
    return { kind: 'postgres', where: hostOf(maskDatabaseUrl(binding.databaseUrl)) }
  }
  return { kind: 'file', path: tildify(resolve(dir, binding?.dbPath ?? '.kanbo/board.db')) }
}

/** The host of an already masked connection string; a string that is not one names no host. */
function hostOf(maskedUrl: string): string {
  try {
    const { host } = new URL(maskedUrl)
    return host && !host.includes('*') ? host : 'a Postgres database'
  }
  catch {
    return 'a Postgres database'
  }
}

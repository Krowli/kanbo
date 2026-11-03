import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { migrateBoardFile } from '../sqlite/migrate'
import { markBoardFileOwnedByKanbo, openBoardDatabase } from '../sqlite/open-database'
import { writeBinding } from './binding'
import { openBoardSession } from './command'
import { projectRegistryPath, readProjectRegistry, rememberProject } from './project-registry'

/**
 * The list of project folders in the user's home: written once a day at most,
 * pruned of folders that are no longer bound, and holding nothing but a path
 * and a time.
 */

const DAY = 24 * 60 * 60
const NOW = 1_730_000_000

describe('the project registry', () => {
  let root: string
  let registryPath: string
  const originalCwd = process.cwd()

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kanbo-registry-'))
    registryPath = join(root, 'home', 'projects.json')
  })

  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(root, { recursive: true, force: true })
  })

  function makeProject(name: string, extra: { databaseUrl?: string } = {}): string {
    const dir = join(root, name)
    mkdirSync(dir, { recursive: true })
    writeBinding(dir, { schemaVersion: 1, workspaceId: 'w', ...extra })
    return dir
  }

  it('writes a new project with its canonical path and the time', () => {
    const dir = makeProject('a')
    rememberProject(dir, { now: NOW, path: registryPath })
    expect(readProjectRegistry(registryPath)).toEqual([{ path: realpathSync(dir), lastSeenAt: NOW }])
  })

  it('leaves the file untouched when the project was noted within a day', () => {
    const dir = makeProject('a')
    rememberProject(dir, { now: NOW, path: registryPath })
    const before = readFileSync(registryPath, 'utf8')
    rememberProject(dir, { now: NOW + DAY - 1, path: registryPath })
    expect(readFileSync(registryPath, 'utf8')).toBe(before)
  })

  it('updates the time after a day and keeps one entry', () => {
    const dir = makeProject('a')
    rememberProject(dir, { now: NOW, path: registryPath })
    rememberProject(dir, { now: NOW + DAY + 1, path: registryPath })
    expect(readProjectRegistry(registryPath)).toEqual([{ path: realpathSync(dir), lastSeenAt: NOW + DAY + 1 }])
  })

  it('lists the most recent project first', () => {
    const first = makeProject('a')
    const second = makeProject('b')
    rememberProject(first, { now: NOW, path: registryPath })
    rememberProject(second, { now: NOW + 10, path: registryPath })
    expect(readProjectRegistry(registryPath).map(project => project.path)).toEqual([realpathSync(second), realpathSync(first)])
  })

  it('reads a file that is not JSON as empty and replaces it on the next write', () => {
    const dir = makeProject('a')
    mkdirSync(join(root, 'home'), { recursive: true })
    writeFileSync(registryPath, 'not json {')
    expect(readProjectRegistry(registryPath)).toEqual([])
    rememberProject(dir, { now: NOW, path: registryPath })
    expect(readProjectRegistry(registryPath)).toEqual([{ path: realpathSync(dir), lastSeenAt: NOW }])
  })

  it('drops a project whose binding is gone on the next write', () => {
    const gone = makeProject('gone')
    const kept = makeProject('kept')
    rememberProject(gone, { now: NOW, path: registryPath })
    rmSync(join(gone, '.kanbo'), { recursive: true, force: true })
    rememberProject(kept, { now: NOW + 10, path: registryPath })
    expect(readProjectRegistry(registryPath).map(project => project.path)).toEqual([realpathSync(kept)])
  })

  it('never stores a connection string', () => {
    const dir = makeProject('pg', { databaseUrl: 'postgres://user:secret@host/db' })
    rememberProject(dir, { now: NOW, path: registryPath })
    const text = readFileSync(registryPath, 'utf8')
    expect(text).not.toContain('secret')
    expect(text).not.toContain('postgres://')
  })

  it.skipIf(process.platform === 'win32')('keeps the file private to the user', () => {
    rememberProject(makeProject('a'), { now: NOW, path: registryPath })
    expect(statSync(registryPath).mode & 0o777).toBe(0o600)
  })

  it('finds the file in KANBO_HOME, else in ~/.kanbo', () => {
    expect(projectRegistryPath({ KANBO_HOME: '/x' })).toBe(join('/x', 'projects.json'))
    expect(projectRegistryPath({})).toMatch(/\.kanbo[\\/]projects\.json$/)
  })

  it('notes the project when a board command opens its board', async () => {
    const dir = makeProject('real')
    const board = await openBoardDatabase(join(dir, '.kanbo', 'board.db'))
    migrateBoardFile(board.database)
    markBoardFileOwnedByKanbo(board.database)
    board.close()
    writeBinding(dir, { schemaVersion: 1, workspaceId: 'w', dbPath: join('.kanbo', 'board.db'), identifier: 'WOR' })
    vi.stubEnv('KANBO_HOME', join(root, 'home'))
    vi.stubEnv('KANBO_DB_PATH', undefined)
    vi.stubEnv('KANBO_DATABASE_URL', undefined)
    vi.stubEnv('KANBO_WORKSPACE_ID', undefined)
    process.chdir(dir)

    try {
      const session = await openBoardSession({}, 'read')
      await session.close()
    }
    finally {
      vi.unstubAllEnvs()
    }

    expect(readProjectRegistry(registryPath).map(project => project.path)).toEqual([realpathSync(dir)])
  })
})

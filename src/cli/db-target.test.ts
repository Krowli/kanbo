import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { migrateBoardFile } from '../sqlite/migrate'
import { markBoardFileOwnedByKanbo, openBoardDatabase } from '../sqlite/open-database'
import { seedHostWorkspace } from '../testing/board-database'
import { writeBinding } from './binding'
import { DATABASE_NOT_FOUND_MESSAGE, resolveDbTarget, TWO_BOARDS_MESSAGE } from './db-target'
import { CliError, EXIT_NOT_RESOLVED } from './output'

/** A connection string shaped like a real one, pointing nowhere. */
const URL_FROM_FLAG = 'postgres://flag:secret@flag.example:5432/board'
const URL_FROM_ENVIRONMENT = 'postgres://env:secret@env.example:5432/board'
const URL_FROM_BINDING = 'postgres://bound:secret@bound.example:5432/board'
const AGENT_URL_FROM_BINDING = 'postgres://kanban_agent:other@bound.example:5432/board'

describe('the board a command opens', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'kanbo-db-target-'))
    for (const name of [
      'KANBO_DB_PATH',
      'KANBO_DATABASE_URL',
      'KANBO_ACTOR_KIND',
    ]) {
      vi.stubEnv(name, undefined)
    }
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(directory, { force: true, recursive: true })
  })

  /** An existing database file at `name`, since resolution requires the file to be there. */
  function createDatabaseFile(...name: string[]): string {
    const path = join(directory, ...name)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, '')
    return path
  }

  /** A project folder bound to an external board, with or without a second login for agents. */
  function bindToDatabase(url: string, agentUrl?: string): string {
    const projectDir = join(directory, 'project')
    mkdirSync(projectDir, { recursive: true })
    writeBinding(projectDir, {
      schemaVersion: 1,
      workspaceId: 'workspace',
      boardId: null,
      dbPath: null,
      databaseUrl: url,
      identifier: 'WOR',
      ...(agentUrl ? { agentDatabaseUrl: agentUrl } : {}),
    })
    return projectDir
  }

  it('obeys --db over KANBO_DB_PATH', () => {
    const explicit = createDatabaseFile('explicit.db')
    vi.stubEnv('KANBO_DB_PATH', createDatabaseFile('kanbo-env.db'))

    expect(resolveDbTarget({ explicitPath: explicit })).toEqual({ kind: 'sqlite', owner: 'host', path: explicit })
  })

  it('falls back to KANBO_DB_PATH', () => {
    const kanboEnv = createDatabaseFile('kanbo-env.db')
    vi.stubEnv('KANBO_DB_PATH', kanboEnv)

    expect(resolveDbTarget()).toEqual({ kind: 'sqlite', owner: 'host', path: kanboEnv })
  })

  it('refuses a path that is not there rather than opening an empty database', () => {
    expect(() => resolveDbTarget({ explicitPath: join(directory, 'missing.db') }))
      .toThrowError(expect.objectContaining({ exitCode: 2, message: DATABASE_NOT_FOUND_MESSAGE }))
    vi.stubEnv('KANBO_DB_PATH', join(directory, 'also-missing.db'))
    expect(() => resolveDbTarget()).toThrowError(CliError)
  })

  it('says what to do when nothing names a board at all', () => {
    expect(() => resolveDbTarget({ cwd: directory }))
      .toThrowError(expect.objectContaining({ exitCode: 2, message: DATABASE_NOT_FOUND_MESSAGE }))
    expect(DATABASE_NOT_FOUND_MESSAGE)
      .toBe('This folder has no kanbo board yet. Run kanbo to set one up (or kanbo init --yes for the defaults).')
  })

  it('tells an agent to ask a person instead', () => {
    vi.stubEnv('CLAUDECODE', '1')

    expect(() => resolveDbTarget({ cwd: directory }))
      .toThrowError(expect.objectContaining({
        exitCode: 2,
        message: 'This folder has no kanbo board yet. Ask a person to run kanbo here.\n'
          + 'If you are a person in an editor terminal, run: KANBO_ACTOR_KIND=person kanbo',
      }))
  })

  it('obeys --database-url over the environment, the binding and every board file', () => {
    const projectDir = bindToDatabase(URL_FROM_BINDING)
    vi.stubEnv('KANBO_DATABASE_URL', URL_FROM_ENVIRONMENT)
    vi.stubEnv('KANBO_DB_PATH', createDatabaseFile('kanbo-env.db'))

    expect(resolveDbTarget({ explicitUrl: URL_FROM_FLAG, cwd: projectDir }))
      .toEqual({ kind: 'postgres', url: URL_FROM_FLAG })
  })

  it('takes KANBO_DATABASE_URL over the binding, and the binding over the board file', () => {
    const projectDir = bindToDatabase(URL_FROM_BINDING)
    vi.stubEnv('KANBO_DB_PATH', createDatabaseFile('kanbo-env.db'))

    vi.stubEnv('KANBO_DATABASE_URL', URL_FROM_ENVIRONMENT)
    expect(resolveDbTarget({ cwd: projectDir })).toEqual({ kind: 'postgres', url: URL_FROM_ENVIRONMENT })

    vi.stubEnv('KANBO_DATABASE_URL', undefined)
    expect(resolveDbTarget({ cwd: projectDir })).toEqual({ kind: 'postgres', url: URL_FROM_BINDING })
  })

  it('reads the binding from a subdirectory of the project it belongs to', () => {
    const projectDir = bindToDatabase(URL_FROM_BINDING)
    const deep = join(projectDir, 'packages', 'web')
    mkdirSync(deep, { recursive: true })

    expect(resolveDbTarget({ cwd: deep })).toEqual({ kind: 'postgres', url: URL_FROM_BINDING })
  })

  it('goes back to the board file for a project bound to no database', () => {
    const projectDir = join(directory, 'plain')
    mkdirSync(projectDir, { recursive: true })
    writeBinding(projectDir, { schemaVersion: 1, workspaceId: 'workspace', boardId: null, dbPath: null })
    const file = createDatabaseFile('kanbo-env.db')
    vi.stubEnv('KANBO_DB_PATH', file)

    expect(resolveDbTarget({ cwd: projectDir })).toEqual({ kind: 'sqlite', owner: 'host', path: file })
  })

  it('keeps a typed --db, whatever connection string is in reach', () => {
    // A flag is a person looking at that file; an exported connection string
    // left over from another project is not a reason to open something else.
    const projectDir = bindToDatabase(URL_FROM_BINDING)
    const explicit = createDatabaseFile('explicit.db')
    vi.stubEnv('KANBO_DATABASE_URL', URL_FROM_ENVIRONMENT)

    expect(resolveDbTarget({ explicitPath: explicit, cwd: projectDir })).toEqual({ kind: 'sqlite', owner: 'host', path: explicit })
  })

  it('refuses to be told about two boards at once', () => {
    const explicit = createDatabaseFile('explicit.db')

    const refusal = expect.objectContaining({ exitCode: 1, message: TWO_BOARDS_MESSAGE })
    expect(() => resolveDbTarget({ explicitPath: explicit, explicitUrl: URL_FROM_FLAG })).toThrowError(refusal)
  })

  it('gives an agent the login the agent role has, and a person the one they own', () => {
    const projectDir = bindToDatabase(URL_FROM_BINDING, AGENT_URL_FROM_BINDING)

    expect(resolveDbTarget({ cwd: projectDir })).toEqual({ kind: 'postgres', url: URL_FROM_BINDING })
    // `kanbo mcp` says so outright; a shell is asked about KANBO_ACTOR_KIND.
    expect(resolveDbTarget({ cwd: projectDir, asAgent: true })).toEqual({ kind: 'postgres', url: AGENT_URL_FROM_BINDING })
    vi.stubEnv('KANBO_ACTOR_KIND', 'agent')
    expect(resolveDbTarget({ cwd: projectDir })).toEqual({ kind: 'postgres', url: AGENT_URL_FROM_BINDING })
  })

  it('hands everybody the one string a project with one gives', () => {
    const projectDir = bindToDatabase(URL_FROM_BINDING)
    vi.stubEnv('KANBO_ACTOR_KIND', 'agent')

    expect(resolveDbTarget({ cwd: projectDir, asAgent: true })).toEqual({ kind: 'postgres', url: URL_FROM_BINDING })
  })

  describe('the board file a project was bound to by kanbo init --file', () => {
    /** A project bound to a board file of its own — the same shape `kanbo init --file` writes. */
    function bindToOwnFile(relativeDbPath: string): { projectDir: string, dbPath: string } {
      const projectDir = join(directory, 'own-file-project')
      mkdirSync(projectDir, { recursive: true })
      const dbPath = createDatabaseFile('own-file-project', ...relativeDbPath.split('/'))
      writeBinding(projectDir, {
        schemaVersion: 1,
        workspaceId: 'workspace',
        boardId: null,
        dbPath: relativeDbPath,
        identifier: 'OWN',
      })
      return { projectDir, dbPath }
    }

    it('is honoured below every connection string', () => {
      const { projectDir } = bindToOwnFile('.kanbo/board.db')
      vi.stubEnv('KANBO_DATABASE_URL', URL_FROM_ENVIRONMENT)

      expect(resolveDbTarget({ cwd: projectDir })).toEqual({ kind: 'postgres', url: URL_FROM_ENVIRONMENT })
    })

    it('is honoured above KANBO_DB_PATH, once there is no connection string in reach', () => {
      const { projectDir, dbPath } = bindToOwnFile('.kanbo/board.db')
      vi.stubEnv('KANBO_DB_PATH', createDatabaseFile('kanbo-env.db'))

      expect(resolveDbTarget({ cwd: projectDir })).toEqual({ kind: 'sqlite', owner: 'host', path: dbPath })
    })

    it('resolves a relative dbPath against the project root, not the working directory it was found from', () => {
      const { projectDir, dbPath } = bindToOwnFile('.kanbo/board.db')
      const deep = join(projectDir, 'packages', 'web')
      mkdirSync(deep, { recursive: true })

      expect(resolveDbTarget({ cwd: deep })).toEqual({ kind: 'sqlite', owner: 'host', path: dbPath })
    })

    it('resolves a dbPath outside .kanbo the same way', () => {
      const { projectDir, dbPath } = bindToOwnFile('boards/team.db')

      expect(resolveDbTarget({ cwd: projectDir })).toEqual({ kind: 'sqlite', owner: 'host', path: dbPath })
    })

    it('gives way to an explicit --db, exactly like every other fallback', () => {
      const { projectDir } = bindToOwnFile('.kanbo/board.db')
      const explicit = createDatabaseFile('explicit.db')

      expect(resolveDbTarget({ explicitPath: explicit, cwd: projectDir })).toEqual({ kind: 'sqlite', owner: 'host', path: explicit })
    })
  })

  describe('who owns a board file', () => {
    /** A real board file this package migrated, with or without the `kanbo init --file` marker. */
    async function buildBoardFile(name: string, mark: boolean): Promise<string> {
      const path = join(directory, name)
      const board = await openBoardDatabase(path)
      migrateBoardFile(board.database)
      if (mark) {
        markBoardFileOwnedByKanbo(board.database)
      }
      board.close()
      return path
    }

    it('reads "kanbo" off the marker kanbo init --file leaves', async () => {
      const path = await buildBoardFile('own.db', true)

      expect(resolveDbTarget({ explicitPath: path })).toEqual({ kind: 'sqlite', owner: 'kanbo', path })
    })

    it('calls a migrated board file a host database when the marker is absent, workspaces table or not', async () => {
      const path = await buildBoardFile('host-like.db', false)
      const board = await openBoardDatabase(path)
      seedHostWorkspace(board, 'workspace', 'WOR')
      board.close()

      expect(resolveDbTarget({ explicitPath: path })).toEqual({ kind: 'sqlite', owner: 'host', path })
    })

    it('calls a file with no board in it at all a host database too, rather than failing to resolve a target', () => {
      const path = createDatabaseFile('empty.db')

      expect(resolveDbTarget({ explicitPath: path })).toEqual({ kind: 'sqlite', owner: 'host', path })
    })

    it('refuses a path that is not a SQLite database at all, in one line rather than a driver stack', () => {
      const path = join(directory, 'README.md')
      writeFileSync(path, '# not a database\n')

      // Finding B3: the open sat outside the guard, so this left better-sqlite3's
      // own sentence and its stack where every other wrong board leaves one line.
      expect(() => resolveDbTarget({ explicitPath: path })).toThrowError(expect.objectContaining({
        exitCode: EXIT_NOT_RESOLVED,
        message: expect.stringContaining('is not a board file kanbo can open'),
      }))
    })
  })
})

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import SqliteDriver from 'better-sqlite3'
import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { assertBoardSchema, openBoardDatabase, readBoardFileOwner } from '../sqlite/open-database'
import type { TestBoardDatabase } from '../testing/board-database'
import { createTestBoardDatabase, seedHostWorkspace } from '../testing/board-database'
import { readBinding } from './binding'
import { INSTRUCTION_BLOCK, registerInitCommand } from './commands/init'

/**
 * The one way to interrupt a migration half-way from outside it. Off for every
 * other test in this file, which runs the real chain: what is being checked is
 * that a failure leaves no file, and the only honest way to stage one is to
 * make the step that builds the board throw.
 */
const migrationFails = vi.hoisted(() => ({ now: false }))

/** Every time `init` reaches for a host database. `--file` never may. */
const hostLookups = vi.hoisted(() => ({ count: 0 }))

vi.mock('./db-target', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./db-target')>()
  return {
    ...actual,
    resolveHostDbPath: (explicitPath?: string | null) => {
      hostLookups.count += 1
      return actual.resolveHostDbPath(explicitPath)
    },
  }
})

vi.mock('../sqlite/migrate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sqlite/migrate')>()
  return {
    ...actual,
    migrateBoardFile: (database: Parameters<typeof actual.migrateBoardFile>[0]) => {
      if (migrationFails.now) {
        throw new Error('migration interrupted')
      }
      actual.migrateBoardFile(database)
    },
  }
})

const WORKSPACE_ID = 'workspace'

/** A connection string shaped like a real one, pointing nowhere. */
const DATABASE_URL = 'postgres://owner:secret@board.example:5432/board'

/** The one an agent reaches the board with instead, once the roles exist. */
const AGENT_URL = 'postgres://kanban_agent:other@board.example:5432/board'

describe('kanbo init', () => {
  let board: TestBoardDatabase
  let projectDir: string

  beforeEach(async () => {
    board = await createTestBoardDatabase()
    seedHostWorkspace(board, WORKSPACE_ID, 'WOR')
    projectDir = mkdtempSync(join(tmpdir(), 'kanbo-init-'))
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir)
    for (const name of [
      'KANBO_DB_PATH',
      'KANBO_WORKSPACE_ID',
      'KANBO_DATABASE_URL',
    ]) {
      vi.stubEnv(name, undefined)
    }
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    rmSync(projectDir, { force: true, recursive: true })
    board.dispose()
  })

  async function run(argv: string[] = []): Promise<void> {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const program = new Command().exitOverride()
    registerInitCommand(program)
    await program.parseAsync(
      ['init', '--db', board.path, '--workspace', WORKSPACE_ID, '--yes', ...argv],
      { from: 'user' },
    )
  }

  /**
   * The same command binding the project to an external board.
   *
   * `--db` and `--database-url` name two boards and are refused together, so
   * the host database — the one `init` reads the workspace and its card key
   * off — is named by the environment, as an app that embeds the board names
   * it for the shells it starts.
   */
  async function runExternal(argv: string[]): Promise<void> {
    vi.stubEnv('KANBO_DB_PATH', board.path)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const program = new Command().exitOverride()
    registerInitCommand(program)
    await program.parseAsync(['init', '--workspace', WORKSPACE_ID, '--yes', ...argv], { from: 'user' })
  }

  /** The same command with no host database in reach, as it would run on a machine that has none. */
  async function runWithoutHost(argv: string[]): Promise<void> {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const program = new Command().exitOverride()
    registerInitCommand(program)
    await program.parseAsync(['init', '--yes', ...argv], { from: 'user' })
  }

  /** `kanbo init --file`, on a machine with no host database in reach at all. */
  async function runFile(argv: string[]): Promise<void> {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const program = new Command().exitOverride()
    registerInitCommand(program)
    await program.parseAsync(['init', '--file', ...argv, '--yes'], { from: 'user' })
  }

  /**
   * The same, with the host database this suite already seeded in reach — which
   * `--file` must now ignore entirely (ruling 5-9): the id and the card key are
   * what was typed, and nothing is looked up in a database that happens to be
   * installed on this machine.
   */
  async function runFileWithHost(workspace: string, identifier: string): Promise<void> {
    vi.stubEnv('KANBO_DB_PATH', board.path)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const program = new Command().exitOverride()
    registerInitCommand(program)
    await program.parseAsync(
      ['init', '--file', '--workspace', workspace, '--identifier', identifier, '--yes'],
      { from: 'user' },
    )
  }

  function read(...path: string[]): string {
    return readFileSync(join(projectDir, ...path), 'utf8')
  }

  it('binds the project, and keeps the binding — and only the binding — out of git', async () => {
    await run()

    expect(readBinding(join(projectDir, '.kanbo', 'binding.json')))
      .toEqual({ schemaVersion: 1, workspaceId: WORKSPACE_ID, boardId: null, dbPath: null })
    expect(read('.kanbo', '.gitignore')).toBe('binding.json\n')
    expect(existsSync(join(projectDir, '.gitignore'))).toBe(false)
  })

  // Keeping it out of a repository is not keeping it away from the other
  // accounts on this machine, and it may hold one or two connection strings.
  // A second `init` rewrites an existing file, where `mode` does not apply, so
  // both runs are checked.
  it.runIf(process.platform !== 'win32')('writes the binding readable by nobody but its owner', async () => {
    await run()
    expect(statSync(join(projectDir, '.kanbo', 'binding.json')).mode & 0o777).toBe(0o600)

    chmodSync(join(projectDir, '.kanbo', 'binding.json'), 0o644)
    await run()

    expect(statSync(join(projectDir, '.kanbo', 'binding.json')).mode & 0o777).toBe(0o600)
  })

  it('keeps its ignore lines in .kanbo, adds each once, and never touches another tool\'s directory', async () => {
    mkdirSync(join(projectDir, '.other-tool'))
    writeFileSync(join(projectDir, '.other-tool', '.gitignore'), '# ours\nscratch/\n')
    writeFileSync(join(projectDir, '.other-tool', 'worktrees.json'), '{}\n')
    mkdirSync(join(projectDir, '.kanbo'))
    writeFileSync(join(projectDir, '.kanbo', '.gitignore'), '# ours\n')

    await run()
    const afterFirst = read('.kanbo', '.gitignore')

    await run()

    expect(afterFirst).toBe('# ours\nbinding.json\n')
    expect(read('.kanbo', '.gitignore')).toBe(afterFirst)
    expect(read('.other-tool', '.gitignore')).toBe('# ours\nscratch/\n')
    expect(read('.other-tool', 'worktrees.json')).toBe('{}\n')
  })

  it('writes the instruction block once, and changes nothing the second time', async () => {
    writeFileSync(join(projectDir, 'CLAUDE.md'), '# Project\n\nOur own instructions.\n')

    await run(['--instructions', 'claude'])
    const afterFirst = read('CLAUDE.md')

    await run(['--instructions', 'claude'])

    expect(afterFirst).toContain('Our own instructions.')
    expect(afterFirst).toContain(INSTRUCTION_BLOCK)
    expect(afterFirst.match(/KANBO_START/g)).toHaveLength(1)
    expect(read('CLAUDE.md')).toBe(afterFirst)
  })

  it('leaves the instruction files alone when told to write to neither', async () => {
    await run(['--instructions', 'none'])

    expect(existsSync(join(projectDir, 'CLAUDE.md'))).toBe(false)
    expect(existsSync(join(projectDir, 'AGENTS.md'))).toBe(false)
  })

  it('registers the MCP server only with the tools --mcp names', async () => {
    await run(['--mcp', 'claude'])

    expect(JSON.parse(read('.mcp.json'))).toEqual({
      mcpServers: { kanbo: { type: 'stdio', command: 'kanbo', args: ['mcp'] } },
    })
    expect(existsSync(join(projectDir, '.codex', 'config.toml'))).toBe(false)
    expect(existsSync(join(projectDir, '.cursor', 'mcp.json'))).toBe(false)
  })

  it('touches no tool configuration without the flag', async () => {
    await run()

    expect(existsSync(join(projectDir, '.mcp.json'))).toBe(false)
    expect(existsSync(join(projectDir, '.codex', 'config.toml'))).toBe(false)
  })

  it('merges into the servers a project already has, and leaves an entry of its own name alone', async () => {
    writeFileSync(
      join(projectDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { other: { type: 'stdio', command: 'other' } } }),
    )
    mkdirSync(join(projectDir, '.codex'))
    writeFileSync(join(projectDir, '.codex', 'config.toml'), 'model = "gpt-5"\n')

    await run(['--mcp', 'claude,codex'])
    const codexAfterFirst = read('.codex', 'config.toml')
    writeFileSync(join(projectDir, '.mcp.json'), read('.mcp.json').replace('"command": "kanbo"', '"command": "kanbo-fork"'))

    await run(['--mcp', 'claude,codex'])

    expect(JSON.parse(read('.mcp.json')).mcpServers.other).toEqual({ type: 'stdio', command: 'other' })
    expect(JSON.parse(read('.mcp.json')).mcpServers.kanbo.command).toBe('kanbo-fork')
    expect(codexAfterFirst).toBe('model = "gpt-5"\n\n[mcp_servers.kanbo]\ncommand = "kanbo"\nargs = ["mcp"]\n')
    expect(read('.codex', 'config.toml')).toBe(codexAfterFirst)
  })

  it('reads a quoted Codex table as the registration it is', async () => {
    const quoted = '[mcp_servers."kanbo"]\ncommand = "kanbo-fork"\nargs = ["mcp"]\n'
    mkdirSync(join(projectDir, '.codex'))
    writeFileSync(join(projectDir, '.codex', 'config.toml'), quoted)

    await run(['--mcp', 'codex'])

    expect(read('.codex', 'config.toml')).toBe(quoted)
  })

  it('writes the external board and the card key into the binding', async () => {
    await runExternal(['--database-url', DATABASE_URL])

    expect(readBinding(join(projectDir, '.kanbo', 'binding.json'))).toEqual({
      schemaVersion: 1,
      workspaceId: WORKSPACE_ID,
      boardId: null,
      dbPath: null,
      databaseUrl: DATABASE_URL,
      // Read off the host database, which is the one place that knows it.
      identifier: 'WOR',
    })
  })

  it('takes the workspace and its key from the flags when there is no host database to ask', async () => {
    await runWithoutHost(['--database-url', DATABASE_URL, '--workspace', 'ws-elsewhere', '--identifier', 'OTH'])

    expect(readBinding(join(projectDir, '.kanbo', 'binding.json'))).toEqual({
      schemaVersion: 1,
      workspaceId: 'ws-elsewhere',
      boardId: null,
      dbPath: null,
      databaseUrl: DATABASE_URL,
      identifier: 'OTH',
    })
  })

  it('takes --db as the host database to read the workspace off, beside the board it binds', async () => {
    // The one command where the two board flags stand together: `--db` is not
    // the board here, it is where this project's workspace is written down.
    await runWithoutHost(['--db', board.path, '--workspace', WORKSPACE_ID, '--database-url', DATABASE_URL])

    expect(readBinding(join(projectDir, '.kanbo', 'binding.json'))).toEqual({
      schemaVersion: 1,
      workspaceId: WORKSPACE_ID,
      boardId: null,
      dbPath: null,
      databaseUrl: DATABASE_URL,
      identifier: 'WOR',
    })
  })

  it('refuses a workspace the host database does not have, instead of writing the name down as an id', async () => {
    const refusal = expect.objectContaining({
      exitCode: 2,
      message: expect.stringContaining('No workspace in this database matches'),
    })
    await expect(runExternal([
      '--database-url',
      DATABASE_URL,
      '--workspace',
      'not-a-workspace',
      '--identifier',
      'OTH',
    ])).rejects.toThrowError(refusal)

    expect(existsSync(join(projectDir, '.kanbo', 'binding.json'))).toBe(false)
  })

  it('keeps every field a second init says nothing about', async () => {
    await runExternal(['--database-url', DATABASE_URL, '--agent-url', AGENT_URL, '--board', 'board-1'])

    vi.spyOn(console, 'error').mockImplementation(() => {})
    await runExternal(['--instructions', 'none'])

    expect(readBinding(join(projectDir, '.kanbo', 'binding.json'))).toEqual({
      schemaVersion: 1,
      workspaceId: WORKSPACE_ID,
      boardId: 'board-1',
      dbPath: null,
      databaseUrl: DATABASE_URL,
      identifier: 'WOR',
      agentDatabaseUrl: AGENT_URL,
    })
  })

  it('refuses to invent a card key, and says which two flags would settle it', async () => {
    const refusal = expect.objectContaining({
      exitCode: 2,
      message: expect.stringContaining('--workspace <id> --identifier <KEY>'),
    })
    await expect(runWithoutHost(['--database-url', DATABASE_URL])).rejects.toThrowError(refusal)
    expect(existsSync(join(projectDir, '.kanbo', 'binding.json'))).toBe(false)
  })

  it('writes the agent\'s own login beside the board\'s, and says nothing about it', async () => {
    const warnings: string[] = []
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      warnings.push(String(line))
    })

    await runExternal(['--database-url', DATABASE_URL, '--agent-url', AGENT_URL])

    expect(readBinding(join(projectDir, '.kanbo', 'binding.json'))?.agentDatabaseUrl).toBe(AGENT_URL)
    expect(warnings).toEqual([])
  })

  it('warns, once, that an agent could otherwise approve its own work', async () => {
    const warnings: string[] = []
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      warnings.push(String(line))
    })

    await runExternal(['--database-url', DATABASE_URL, '--mcp', 'claude'])

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('kanbo roles apply')
    expect(warnings[0]).toContain('--agent-url')
    // The warning is about the string, and never says it.
    expect(warnings[0]).not.toContain('secret')
  })

  it('puts no connection string in a file the project shares', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await runExternal(['--database-url', DATABASE_URL, '--agent-url', AGENT_URL, '--mcp', 'claude,codex,cursor'])

    // `.mcp.json`, `.codex/config.toml` and `.cursor/mcp.json` are committed;
    // the binding is the one file `init` keeps out of git, and the one place
    // the string is written down. `kanbo mcp` resolves the board from it.
    expect(JSON.parse(read('.mcp.json'))).toEqual({
      mcpServers: { kanbo: { type: 'stdio', command: 'kanbo', args: ['mcp'] } },
    })
    expect(JSON.parse(read('.cursor', 'mcp.json'))).toEqual({
      mcpServers: { kanbo: { type: 'stdio', command: 'kanbo', args: ['mcp'] } },
    })
    expect(read('.codex', 'config.toml'))
      .toBe('[mcp_servers.kanbo]\ncommand = "kanbo"\nargs = ["mcp"]\n')
    for (const file of [read('.mcp.json'), read('.codex', 'config.toml'), read('.cursor', 'mcp.json')]) {
      expect(file).not.toContain('secret')
      expect(file).not.toContain('board.example')
    }
  })

  it('refuses a tool configuration it cannot merge into, and leaves the file alone', async () => {
    writeFileSync(join(projectDir, '.mcp.json'), '["not an object"]')

    await expect(run(['--mcp', 'claude'])).rejects.toThrowError(/does not hold a JSON object/)
    expect(read('.mcp.json')).toBe('["not an object"]')
  })

  describe('--file: a board file of this project\'s own', () => {
    it('creates and migrates the file, with no host database and no Postgres involved', async () => {
      await runFile([])

      const dbPath = join(projectDir, '.kanbo', 'board.db')
      expect(existsSync(dbPath)).toBe(true)

      const owned = await openBoardDatabase(dbPath)
      try {
        expect(() => assertBoardSchema(owned.database)).not.toThrow()
        expect(readBoardFileOwner(owned.database)).toBe('kanbo')
      }
      finally {
        owned.close()
      }
    })

    it('writes the binding\'s dbPath, and — with no host database — a workspace and key slugged from the folder name', async () => {
      await runFile([])

      // mkdtempSync's own suffix may carry uppercase characters; the slug does not.
      const slug = basename(projectDir).toLowerCase()
      expect(readBinding(join(projectDir, '.kanbo', 'binding.json'))).toEqual({
        schemaVersion: 1,
        workspaceId: slug,
        boardId: null,
        dbPath: join('.kanbo', 'board.db'),
        identifier: slug,
      })
    })

    it('covers the board file and its WAL siblings in .kanbo/.gitignore, alongside the binding', async () => {
      await runFile([])

      const lines = read('.kanbo', '.gitignore').split('\n')
      expect(lines).toEqual(expect.arrayContaining(['binding.json', 'board.db', 'board.db-wal', 'board.db-shm']))
    })

    it('is idempotent: running it again leaves the file, the binding and the ignore file unchanged', async () => {
      await runFile([])
      const firstBinding = readBinding(join(projectDir, '.kanbo', 'binding.json'))
      const firstGitignore = read('.kanbo', '.gitignore')

      await runFile([])

      expect(readBinding(join(projectDir, '.kanbo', 'binding.json'))).toEqual(firstBinding)
      expect(read('.kanbo', '.gitignore')).toBe(firstGitignore)
    })

    it('uses the path --file names, relative to the project root, and adds no line for it outside .kanbo', async () => {
      await runFile(['boards/team.db'])

      expect(existsSync(join(projectDir, 'boards', 'team.db'))).toBe(true)
      expect(readBinding(join(projectDir, '.kanbo', 'binding.json'))?.dbPath).toBe('boards/team.db')
      // Outside .kanbo: no ignore line is written for it, and the project's own .gitignore is never touched.
      expect(existsSync(join(projectDir, '.gitignore'))).toBe(false)
    })

    it('takes the workspace and its key from --workspace and --identifier when given', async () => {
      await runFile(['--workspace', 'proj', '--identifier', 'PRJ'])

      expect(readBinding(join(projectDir, '.kanbo', 'binding.json'))).toEqual(expect.objectContaining({
        workspaceId: 'proj',
        identifier: 'PRJ',
      }))
    })

    it('takes --workspace and --identifier at face value on a machine that has a host database', async () => {
      // Ruling 5-9. Consulting the host database first would refuse outright
      // when it did not know the name typed - on the one command that exists
      // so a project needs nothing else at all - and leave a board file
      // behind with no binding beside it. The id and the key are now what was
      // typed, whatever this machine happens to have installed.
      await runFileWithHost('demo', 'DEMO')

      expect(readBinding(join(projectDir, '.kanbo', 'binding.json'))).toEqual(expect.objectContaining({
        workspaceId: 'demo',
        identifier: 'DEMO',
      }))
    })

    it('never asks where the host database is, whatever the environment says', async () => {
      // The structural half of ruling 5-9: `resolveHostDbPath` is the only
      // door to a host database, and `--file` does not go through it. Nothing
      // is looked up, so the seeded workspace's own key is not borrowed either
      // - the folder's name fills both ends.
      vi.stubEnv('KANBO_DB_PATH', board.path)
      hostLookups.count = 0

      await runFile(['--workspace', WORKSPACE_ID])

      expect(hostLookups.count).toBe(0)
      const slug = basename(projectDir).toLowerCase()
      expect(readBinding(join(projectDir, '.kanbo', 'binding.json'))).toEqual(expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        identifier: slug,
      }))
    })

    it('keeps the workspace the project is already bound to when it is run again', async () => {
      // Ruling 3-16 and the command-line half of 5-7: the cards in the file are
      // numbered under the id in the binding, and an app that attaches the
      // file may rewrite that id. A second `init` that fell back to the folder slug
      // would point the project at a workspace with no cards in it.
      await runFile(['--workspace', 'host-uuid', '--identifier', 'HST'])

      await runFile([])

      expect(readBinding(join(projectDir, '.kanbo', 'binding.json'))).toEqual(expect.objectContaining({
        workspaceId: 'host-uuid',
        identifier: 'HST',
      }))
    })

    it('leaves no file behind when the migration fails half-way', async () => {
      migrationFails.now = true
      try {
        await expect(runFile([])).rejects.toThrowError(/migration interrupted/)
      }
      finally {
        migrationFails.now = false
      }

      // Not the board file, not a half-built temporary one, and not a binding
      // pointing at either (ruling 5-9).
      expect(existsSync(join(projectDir, '.kanbo', 'board.db'))).toBe(false)
      expect(readdirSync(join(projectDir, '.kanbo'))).not.toContain(expect.stringContaining('board.db'))
      expect(existsSync(join(projectDir, '.kanbo', 'binding.json'))).toBe(false)
    })

    it('refuses a --file path that already holds a database of somebody else\'s, and writes nothing', async () => {
      const strangersPath = join(projectDir, 'app.db')
      const stranger = new SqliteDriver(strangersPath)
      stranger.exec('create table my_notes (id text primary key)')
      stranger.close()
      const before = statSync(strangersPath).size

      await expect(runFile(['app.db'])).rejects.toThrowError(/already holds a database of its own/)

      expect(statSync(strangersPath).size).toBe(before)
      expect(existsSync(join(projectDir, '.kanbo', 'binding.json'))).toBe(false)
    })

    it('refuses --file together with --database-url, and creates nothing', async () => {
      const refusal = expect.objectContaining({ exitCode: 1, message: expect.stringContaining('One board at a time') })

      await expect(runFile(['--database-url', DATABASE_URL])).rejects.toThrowError(refusal)

      expect(existsSync(join(projectDir, '.kanbo', 'board.db'))).toBe(false)
      expect(existsSync(join(projectDir, '.kanbo', 'binding.json'))).toBe(false)
    })
  })
})

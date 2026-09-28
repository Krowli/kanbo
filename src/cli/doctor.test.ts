import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'

import SqliteDriver from 'better-sqlite3'
import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { writeFakeBin } from '../testing/fake-bin'
import { createPromptDriver } from '../testing/prompt-driver'
import type { KanboProgramContext } from './commands'
import { DOCTOR_FIX_YES_HINT, registerDoctorCommand } from './commands/doctor'
import { registerInitCommand } from './commands/init'
import type { DoctorFinding } from './doctor'
import { collectDoctorFindings } from './doctor'
import { runKanbo } from './program'
import { INSTRUCTION_BLOCK, wrapInstructionBlock } from './setup/instructions'
import { LEGACY_BLOCK_BODIES } from './setup/legacy-blocks'
import { readJsonMcpEntry } from './setup/mcp-config'
import { createUi, setUiForTests } from './ui/ui'
import { startUpdateCheck, UPDATE_CHECK_GRACE_MS, UPDATE_CHECK_TIMEOUT_MS } from './update-check'

/** This package's own command, run from source: what a healthy install's `kanbo` on PATH would be. */
const CLI_ENTRY = join(dirname(fileURLToPath(import.meta.url)), 'index.ts')
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli')

/**
 * The folder the tests run from. `process.cwd` is mocked to the project below,
 * and cross-spawn, which starts the handshake's server, changes into the
 * server's folder to look the command up and then back to what `process.cwd`
 * says — the project. Windows cannot remove a folder a process is in.
 */
const TEST_CWD = process.cwd()

/**
 * `kanbo doctor` on a project made in a temporary folder, with `HOME`,
 * `CODEX_HOME` and `PATH` pointing into it too. The `kanbo` on that PATH is a
 * script the test writes: this package run from source for the healthy case,
 * or one that fails for the broken ones.
 */
describe('kanbo doctor', () => {
  let root: string
  let bin: string
  let projectDir: string
  let kanbo: string

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'kanbo-doctor-'))
    bin = join(root, 'bin')
    projectDir = join(root, 'project')
    kanbo = join(bin, process.platform === 'win32' ? 'kanbo.cmd' : 'kanbo')
    for (const directory of [bin, projectDir, join(root, 'home')]) {
      mkdirSync(directory, { recursive: true })
    }
    vi.stubEnv('HOME', join(root, 'home'))
    vi.stubEnv('USERPROFILE', join(root, 'home'))
    vi.stubEnv('CODEX_HOME', join(root, 'codex-home'))
    vi.stubEnv('PATH', [bin, dirname(process.execPath)].join(delimiter))
    for (const name of ['KANBO_DB_PATH', 'KANBO_DATABASE_URL', 'KANBO_WORKSPACE_ID', 'KANBO_ACTOR_KIND']) {
      vi.stubEnv(name, undefined)
    }
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir)
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const program = new Command().exitOverride()
    registerInitCommand(program)
    await program.parseAsync(
      ['init', '--file', '--instructions', 'claude', '--mcp', 'claude,codex,cursor', '--yes'],
      { from: 'user' },
    )
  })

  afterEach(() => {
    setUiForTests(null)
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    process.chdir(TEST_CWD)
    rmSync(root, { force: true, recursive: true })
  })

  /** A `kanbo` on PATH whose script is `body`, in JavaScript. */
  function installKanbo(body: string): void {
    expect(writeFakeBin(bin, 'kanbo', body)).toBe(kanbo)
  }

  /** A `kanbo` that is this package, run from source, with the streams and exit code passed through. */
  function installRealKanbo(): void {
    installKanbo([
      `const result = require('node:child_process').spawnSync(`,
      `  ${JSON.stringify(process.execPath)},`,
      `  [${JSON.stringify(TSX_CLI)}, ${JSON.stringify(CLI_ENTRY)}, ...process.argv.slice(2)],`,
      `  { stdio: 'inherit' },`,
      `)`,
      `process.exit(result.status ?? 1)`,
    ].join('\n'))
  }

  async function doctor(timeoutMs = 2_000): Promise<DoctorFinding[]> {
    // The script this kanbo runs from: on Windows, the one the `.cmd` shim starts.
    const self = process.platform === 'win32' ? join(bin, 'kanbo.js') : kanbo
    return await collectDoctorFindings({ cwd: projectDir, self, handshakeTimeoutMs: timeoutMs })
  }

  function finding(findings: DoctorFinding[], check: string): DoctorFinding {
    const found = findings.find(entry => entry.check === check)
    expect(found, `no ${check} finding in ${JSON.stringify(findings)}`).toBeDefined()
    return found!
  }

  it('finds nothing wrong with a freshly set up project', async () => {
    installRealKanbo()

    const findings = await doctor(30_000)

    // On Windows the project's portable `kanbo` is npm's kanbo.cmd, which Codex cannot start.
    expect(findings.filter(entry => entry.status !== 'ok')).toEqual(
      process.platform === 'win32' ? [expect.objectContaining({ check: 'mcp:codex', status: 'warn' })] : [],
    )
    expect(findings.map(entry => entry.check)).toEqual([
      'version',
      'path',
      'settings',
      'sqlite',
      'board',
      'instructions',
      'mcp:claude',
      'mcp:codex',
      'mcp:cursor',
      'mcp:handshake',
      'actor',
    ])
  }, 60_000)

  it('fails a project whose .kanbo/ has lost its binding', async () => {
    installKanbo('process.exit(1)')
    rmSync(join(projectDir, '.kanbo', 'binding.json'))

    const binding = finding(await doctor(), 'settings')

    expect(binding.status).toBe('fail')
    expect(binding.fix).toMatch(/kanbo init/)
  })

  it('warns about a block an older kanbo wrote, and says how to rewrite it', async () => {
    installKanbo('process.exit(1)')
    const path = join(projectDir, 'CLAUDE.md')
    // A 0.1.x–0.2.x block is one kanbo wrote only when its body is word for word one those versions wrote.
    writeFileSync(path, `# Notes\n\n<!-- KANBO_START -->\n${LEGACY_BLOCK_BODIES[1]}\n<!-- KANBO_END -->\n`)

    const instructions = finding(await doctor(), 'instructions')

    expect(instructions.status).toBe('warn')
    expect(instructions.detail).toContain('older kanbo')
    expect(instructions.fix).toContain('kanbo connect claude --project --no-mcp --yes')
  })

  it('warns about a block the person edited, without offering --yes', async () => {
    installKanbo('process.exit(1)')
    const path = join(projectDir, 'CLAUDE.md')
    writeFileSync(path, readFileSync(path, 'utf8').replace('Take work with', 'Pick work with'))

    const instructions = finding(await doctor(), 'instructions')

    expect(instructions.status).toBe('warn')
    expect(instructions.detail).toContain('you edited')
    expect(instructions.fix).not.toContain('--yes')
  })

  it('is fine with a block a newer kanbo wrote or a text the person chose, and fails a start marker without an end', async () => {
    installKanbo('process.exit(1)')
    const path = join(projectDir, 'CLAUDE.md')

    writeFileSync(path, `${wrapInstructionBlock('## Kanbo board\n\nNewer words.', 3)}\n`)
    const newer = finding(await doctor(), 'instructions')
    expect(newer.status).toBe('ok')
    expect(newer.detail).toContain('written by a newer kanbo (v3) — update kanbo: npm install -g kanbo-cli@latest')

    writeFileSync(path, `${wrapInstructionBlock('Coordinate the agents.', 2, 'orchestrator')}\n`)
    const chosen = finding(await doctor(), 'instructions')
    expect(chosen.status).toBe('ok')
    expect(chosen.detail).toContain('you chose the orchestrator text')

    writeFileSync(path, '# Notes\n\n<!-- KANBO_START -->\nMine.\n')
    const damaged = finding(await doctor(), 'instructions')
    expect(damaged.status).toBe('fail')
    expect(damaged.fix).toBe(`${path} has a kanbo start marker without an end — fix it by hand, then run again.`)
  })

  it('fails an MCP registration of kanbo\'s own whose command is not on PATH', async () => {
    installKanbo('process.exit(1)')
    const path = join(projectDir, '.mcp.json')
    vi.stubEnv('PATH', join(root, 'home'))

    const claude = finding(await doctor(), 'mcp:claude')

    expect(claude.status).toBe('fail')
    expect(claude.detail).toContain('not on PATH')
    expect(claude.fix).toBeDefined()
    vi.stubEnv('PATH', [bin, dirname(process.execPath)].join(delimiter))
    // An entry of the person's own that cannot start is theirs to fix: a warning, and left as it is.
    writeFileSync(path, readFileSync(path, 'utf8').replace('"command": "kanbo"', '"command": "kanbo-nowhere"'))
    const own = finding(await doctor(), 'mcp:claude')
    expect(own.status).toBe('warn')
    expect(own.detail).toContain('your own kanbo entry (kanbo-nowhere mcp) — left as is')
    expect(finding(await doctor(), 'mcp:codex').status).toBe(process.platform === 'win32' ? 'warn' : 'ok')
  })

  it('checks both the Node and the script of a registration that names them by full path', async () => {
    installKanbo('process.exit(1)')
    const script = join(root, 'kanbo-cli', 'dist', 'cli.cjs')
    const path = join(projectDir, '.cursor', 'mcp.json')
    const register = (command: string) => writeFileSync(path, JSON.stringify({
      mcpServers: { kanbo: { type: 'stdio', command, args: [script, 'mcp'] } },
    }))

    register(process.execPath)
    const missingScript = finding(await doctor(), 'mcp:cursor')
    expect(missingScript.status).toBe('fail')
    expect(missingScript.detail).toContain(script)
    expect(missingScript.fix).toBe('Run kanbo doctor --fix, or kanbo connect cursor --project, to point it at this kanbo.')
    expect(missingScript.repair).toBeDefined()

    mkdirSync(dirname(script), { recursive: true })
    writeFileSync(script, '')
    expect(finding(await doctor(), 'mcp:cursor').status).toBe('ok')

    register(join(root, 'old-node', 'node.exe'))
    const missingNode = finding(await doctor(), 'mcp:cursor')
    expect(missingNode.status).toBe('fail')
    expect(missingNode.detail).toContain(join(root, 'old-node', 'node.exe'))
  })

  it('on Windows warns about a Codex registration that starts a .cmd, even when the handshake would pass', async () => {
    installKanbo('process.exit(1)')
    const path = join(projectDir, '.codex', 'config.toml')
    const onWindows = async () => finding(
      await collectDoctorFindings({ cwd: projectDir, self: null, handshakeTimeoutMs: 2_000, platform: 'win32' }),
      'mcp:codex',
    )

    // What `kanbo init --mcp codex` writes: the bare name, which on Windows finds npm's kanbo.cmd.
    const bare = await onWindows()
    expect(bare.status).toBe('warn')
    // A project entry: take it out of the project, then register kanbo for the person — two commands, two lines.
    expect(bare.fix).toBe('Codex on Windows can\'t start a .cmd. Remove the project entry, then register kanbo for your user:\n'
      + '  kanbo connect codex --project --remove --no-instructions\n'
      + '  kanbo connect codex')

    const shim = join(bin, 'kanbo.cmd')
    writeFileSync(shim, '@echo off\r\n')
    writeFileSync(path, `[mcp_servers.kanbo]\ncommand = ${JSON.stringify(shim)}\nargs = ["mcp"]\n`)
    const shimmed = await onWindows()
    expect(shimmed.status).toBe('warn')
    expect(shimmed.fix).toBe(bare.fix)

    // A Node and a script, by full path, is what Codex can start.
    writeFileSync(path, `[mcp_servers.kanbo]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(CLI_ENTRY)}, "mcp"]\n`)
    expect((await onWindows()).status).toBe('ok')
  })

  it('fails a board file older than this build and points at kanbo migrate', async () => {
    installKanbo('process.exit(1)')
    const database = new SqliteDriver(join(projectDir, '.kanbo', 'board.db'))
    database.prepare('update kanban_meta set revision = 0 where key = \'schema_epoch\'').run()
    database.close()

    const board = finding(await doctor(), 'board')

    expect(board.status).toBe('fail')
    // Another epoch is not something a migration brings: no repair is offered.
    expect(board.fix).toBe('Run kanbo migrate.')
    expect(board.repair).toBeUndefined()
  })

  it('migrates a board file a migration behind with --fix, after saying so in the plan', async () => {
    installKanbo('process.exit(1)')
    // A file from before the last migration: its column gone, and the migration not recorded.
    const database = new SqliteDriver(join(projectDir, '.kanbo', 'board.db'))
    database.prepare('alter table issue_runs drop column external_session_ref').run()
    database.prepare('delete from __drizzle_migrations where created_at = (select max(created_at) from __drizzle_migrations)').run()
    database.close()

    const board = finding(await doctor(), 'board')
    expect(board.status).toBe('fail')
    expect(board.fix).toBe('Run kanbo doctor --fix, or kanbo migrate.')
    // The path as the person's OS spells it, like every path in a kanbo connect plan.
    const shown = join('.kanbo', 'board.db')
    expect(board.repair!.plan).toEqual([`  migrate  ${shown} (brings the board's tables up to this kanbo's schema; every card stays)`])

    expect(await board.repair!.apply()).toEqual([`migrated ${shown}`])
    expect(finding(await doctor(), 'board').status).toBe('ok')
  })

  it('fails the handshake when the kanbo a client would start does not answer', async () => {
    installKanbo('process.stderr.write(\'kanbo: broken install\\n\')\nprocess.exit(1)')

    const handshake = finding(await doctor(), 'mcp:handshake')

    expect(handshake.status).toBe('fail')
    expect(handshake.detail).toContain('broken install')
  })

  it('warns about another kanbo earlier on PATH, and about a shell marked as an agent\'s', async () => {
    installKanbo('process.exit(1)')
    vi.stubEnv('KANBO_ACTOR_KIND', 'agent')

    const findings = await collectDoctorFindings({ cwd: projectDir, self: join(root, 'elsewhere', 'kanbo'), handshakeTimeoutMs: 2_000 })

    expect(finding(findings, 'path').status).toBe('warn')
    expect(finding(findings, 'actor').status).toBe('warn')
  })

  it('exits 1 when a check fails, after printing every finding', async () => {
    installKanbo('process.exit(1)')
    rmSync(join(projectDir, '.kanbo', 'binding.json'))
    const printed: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      printed.push(String(line))
    })

    const program = new Command().exitOverride()
    registerDoctorCommand(program)
    await expect(program.parseAsync(['doctor', '--json'], { from: 'user' }))
      .rejects
      .toThrowError(expect.objectContaining({ exitCode: 1 }))

    const report = JSON.parse(printed.join('\n')) as { findings: DoctorFinding[] }
    expect(finding(report.findings, 'settings').status).toBe('fail')
  })

  it('prints only the fields --json names, as every other command does', async () => {
    installKanbo('process.exit(1)')
    const printed: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      printed.push(String(line))
    })

    const program = new Command().exitOverride()
    registerDoctorCommand(program)
    await program.parseAsync(['doctor', '--json', 'version'], { from: 'user' }).catch(() => undefined)

    expect(Object.keys(JSON.parse(printed.join('\n')) as object)).toEqual(['version'])
  })
  it('says a newer kanbo is out as information, and warns about a kanbo run from npx — neither fixable', async () => {
    installKanbo('process.exit(1)')
    const update = startUpdateCheck({
      fetch: async () => new Response(JSON.stringify({ version: '9.0.0' })),
      env: {},
      currentVersion: '0.3.0',
    })
    const npx = join(root, '.npm', '_npx', 'a1b2', 'node_modules', 'kanbo-cli', 'dist', 'cli.cjs')

    const findings = await collectDoctorFindings({ cwd: projectDir, self: npx, handshakeTimeoutMs: 2_000, update })

    expect(finding(findings, 'update')).toEqual({
      check: 'update',
      status: 'info',
      detail: 'kanbo 9.0.0 is available (you have 0.3.0).',
      fix: 'Update kanbo: npm install -g kanbo-cli@latest',
    })
    expect(finding(findings, 'install')).toMatchObject({ status: 'warn', fix: 'Install kanbo globally: npm install -g kanbo-cli' })
    expect(finding(findings, 'install').repair).toBeUndefined()
  })

  describe('--fix', () => {
    const claudeMd = (): string => join(projectDir, 'CLAUDE.md')
    const agentsMd = (): string => join(projectDir, 'AGENTS.md')
    let printed: string[]

    beforeEach(() => {
      installKanbo('process.exit(1)')
      printed = []
      vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => void printed.push(values.map(String).join(' ')))
      vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => void printed.push(values.map(String).join(' ')))
      setUiForTests(createUi({ input: new PassThrough(), output: new PassThrough() }))
    })

    /** `kanbo doctor <args>`; the error it ended on, or `null`. */
    async function run(...args: string[]): Promise<unknown> {
      const program = new Command().exitOverride()
      registerDoctorCommand(program)
      return await program.parseAsync(['doctor', ...args], { from: 'user' }).then(() => null, (error: unknown) => error)
    }

    /** Every path under the test's folder: what a fix may add to, and must never take from. */
    function listing(): string[] {
      return (readdirSync(root, { recursive: true }) as string[]).map(path => path.replaceAll('\\', '/')).sort()
    }

    /** A 0.1–0.2 block in CLAUDE.md, and a block the person edited in AGENTS.md. */
    function oldAndEditedBlocks(): string {
      writeFileSync(claudeMd(), `# Notes\n\n<!-- KANBO_START -->\n${LEGACY_BLOCK_BODIES[1]}\n<!-- KANBO_END -->\n`)
      const edited = `# Ours\n\n${INSTRUCTION_BLOCK.replace('Take work with', 'Pick work with')}\n`
      writeFileSync(agentsMd(), edited)
      return edited
    }

    it('rewrites an old block with --yes, leaves an edited one alone, and deletes nothing', async () => {
      const edited = oldAndEditedBlocks()
      const before = listing()

      await run('--fix', '--yes')

      expect(readFileSync(claudeMd(), 'utf8')).toBe(`# Notes\n\n${INSTRUCTION_BLOCK}\n`)
      expect(readFileSync(agentsMd(), 'utf8')).toBe(edited)
      const after = listing()
      expect(after.filter(path => !before.includes(path))).toEqual([])
      expect(before.filter(path => !after.includes(path))).toEqual([])
      const output = printed.join('\n')
      expect(output).toContain('kanbo doctor --fix will:\n  write  CLAUDE.md (the kanbo section: Claude Code reads it in this project and runs kanbo prime before a task)')
      expect(output).toContain('Nothing is deleted, and nothing else is changed.')
      expect(output).toContain('  written CLAUDE.md')
      // Checked again: the rewritten block is current; the edited one is still only a warning, with no fix of --fix's.
      const again = output.split('Checked again:')[1]!
      expect(again).toContain(`ok    instructions   ${claudeMd()}: block is current.`)
      expect(again).toContain(`warn  instructions   ${agentsMd()}: you edited the kanbo block`)
    })

    /** `kanbo doctor` as the binary runs it: through `runKanbo`, which starts the run's update check. */
    const doctorProgram = (context: KanboProgramContext): Command => {
      const program = new Command().exitOverride()
      registerDoctorCommand(program, context.update ?? null)
      return program
    }

    it('asks npm once per run: both rounds of --fix report the same answer, and nothing is asked after', async () => {
      oldAndEditedBlocks()
      const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ version: '9.0.0' })))

      await runKanbo(['doctor', '--fix', '--yes'], doctorProgram, {}, { fetch, env: {}, currentVersion: '0.3.0', platform: 'linux' }).catch(() => {})

      expect(fetch).toHaveBeenCalledOnce()
      const output = printed.join('\n')
      expect(output.split('Checked again:')[1]).toContain('info  update         kanbo 9.0.0 is available (you have 0.3.0).')
      expect(printed.filter(line => line.includes('is available'))).toEqual([
        'info  update         kanbo 9.0.0 is available (you have 0.3.0).',
        'info  update         kanbo 9.0.0 is available (you have 0.3.0).',
      ])
    })

    it('waits for a slow npm no more than ~300 ms after its checks, then stops asking', async () => {
      oldAndEditedBlocks()
      let signal: AbortSignal | undefined
      const fetch = vi.fn<typeof globalThis.fetch>((_url, init) => new Promise<Response>((_resolve, reject) => {
        const aborted = init!.signal!
        signal = aborted
        aborted.addEventListener('abort', () => reject(new Error('aborted')))
      }))
      // npm's own timeout never fires; every other wait is recorded and passes at once.
      const waits: number[] = []
      const timers = {
        setTimeout: (callback: () => void, ms: number): unknown => {
          waits.push(ms)
          return waits.length === 1 ? null : setTimeout(callback, 0)
        },
        clearTimeout: (handle: never): void => clearTimeout(handle ?? undefined),
      }

      await runKanbo(['doctor', '--fix', '--yes'], doctorProgram, {}, { fetch, env: {}, timers, currentVersion: '0.3.0', platform: 'linux' }).catch(() => {})

      expect(fetch).toHaveBeenCalledOnce()
      expect(waits[0]).toBe(UPDATE_CHECK_TIMEOUT_MS)
      expect(waits.length).toBeGreaterThan(1)
      expect(waits.slice(1).every(ms => ms <= UPDATE_CHECK_GRACE_MS)).toBe(true)
      expect(signal!.aborted).toBe(true)
      expect(printed.join('\n')).not.toContain('is available')
    })

    it('with nobody to ask and no --yes, prints the plan and how to apply it, and changes nothing', async () => {
      oldAndEditedBlocks()
      const before = readFileSync(claudeMd(), 'utf8')

      const outcome = await run('--fix')

      expect(readFileSync(claudeMd(), 'utf8')).toBe(before)
      const output = printed.join('\n')
      expect(output).toContain('kanbo doctor --fix will:')
      expect(output).toContain(DOCTOR_FIX_YES_HINT)
      expect(output).not.toContain('Checked again:')
      // The handshake fails here (the kanbo on PATH exits 1), so the command still fails.
      expect(outcome).toMatchObject({ exitCode: 1 })
    })

    it('asks once at a terminal, Yes by default, and applies', async () => {
      oldAndEditedBlocks()
      // A person's terminal, even on a CI runner.
      vi.stubEnv('CI', undefined)
      vi.stubEnv('TERM', undefined)
      const driver = createPromptDriver()
      setUiForTests(driver.ui)

      const running = run('--fix')
      await driver.waitFor('Apply these fixes?', 30_000)
      driver.press('enter')
      await running

      expect(readFileSync(claudeMd(), 'utf8')).toBe(`# Notes\n\n${INSTRUCTION_BLOCK}\n`)
    })

    it('gives a board with no columns the Standard ones', async () => {
      const database = new SqliteDriver(join(projectDir, '.kanbo', 'board.db'))
      database.prepare('delete from issue_statuses').run()
      database.close()
      expect(finding(await doctor(), 'columns')).toMatchObject({ status: 'warn', fix: 'Run kanbo doctor --fix, or kanbo columns template standard.' })

      await run('--fix', '--yes')

      const reopened = new SqliteDriver(join(projectDir, '.kanbo', 'board.db'))
      const names = reopened.prepare('select name from issue_statuses order by "order"').all() as { name: string }[]
      reopened.close()
      expect(names.map(row => row.name)).toEqual(['Backlog', 'To Do', 'In Progress', 'In Review', 'Done', 'Canceled'])
      expect(printed.join('\n')).toContain('  add    the Standard columns to the board: Backlog, To Do, In Progress, In Review, Done, Canceled')
      expect((await doctor()).some(entry => entry.check === 'columns')).toBe(false)
    })

    it('rewrites kanbo\'s own Windows registration whose Node moved, as kanbo connect would', async () => {
      const path = join(root, 'home', '.cursor', 'mcp.json')
      mkdirSync(dirname(path), { recursive: true })
      const stale = { command: 'C:\\Program Files\\nodejs-20\\node.exe', args: ['C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\kanbo-cli\\dist\\cli.cjs', 'mcp'] }
      writeFileSync(path, JSON.stringify({ mcpServers: { kanbo: stale, other: { command: 'other-server' } } }, null, 2))

      const findings = await collectDoctorFindings({ cwd: projectDir, self: null, handshakeTimeoutMs: 2_000, platform: 'win32' })
      const cursor = findings.find(entry => entry.check === 'mcp:cursor' && entry.detail.startsWith(path))!
      expect(cursor.status).toBe('fail')
      expect(cursor.fix).toBe('Run kanbo doctor --fix, or kanbo connect cursor --global, to point it at this kanbo.')
      expect(cursor.repair!.plan).toEqual([`  write  ${path} (rewrites a kanbo MCP entry that no longer starts: lets Cursor call the board's tools in every project)`])

      expect(await cursor.repair!.apply()).toEqual([`written ${path}`])

      const entry = readJsonMcpEntry(path)!
      expect(entry.command).toBe(process.execPath)
      expect(entry.args.at(-1)).toBe('mcp')
      expect((JSON.parse(readFileSync(path, 'utf8')) as { mcpServers: Record<string, unknown> }).mcpServers.other).toEqual({ command: 'other-server' })
    })

    it('marks what --fix can fix in --json', async () => {
      oldAndEditedBlocks()

      await run('--json')

      const report = JSON.parse(printed.join('\n')) as { findings: (DoctorFinding & { fixable: boolean })[] }
      const byPath = (path: string) => report.findings.find(entry => entry.check === 'instructions' && entry.detail.startsWith(path))!
      expect(byPath(claudeMd()).fixable).toBe(true)
      expect(byPath(agentsMd()).fixable).toBe(false)
      expect(report.findings.find(entry => entry.check === 'actor')!.fixable).toBe(false)
      expect(report.findings.every(entry => !('repair' in entry))).toBe(true)
    })
  })
})

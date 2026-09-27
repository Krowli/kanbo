import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import SqliteDriver from 'better-sqlite3'
import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { writeFakeBin } from '../testing/fake-bin'
import { registerDoctorCommand } from './commands/doctor'
import { registerInitCommand } from './commands/init'
import type { DoctorFinding } from './doctor'
import { collectDoctorFindings } from './doctor'

/** This package's own command, run from source: what a healthy install's `kanbo` on PATH would be. */
const CLI_ENTRY = join(dirname(fileURLToPath(import.meta.url)), 'index.ts')
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli')

/**
 * `kanbo doctor` on a project made in a temporary folder, with `HOME`,
 * `CODEX_HOME` and `PATH` pointing into it too. The `kanbo` on that PATH is a
 * script the test writes: this package run from source for the healthy case,
 * or one that fails for the broken ones.
 */
/**
 * Remove a test's folder. On Windows a folder cannot go while a process has it
 * as its working directory — the server the handshake started, until it has
 * exited — so this waits for that, up to 15 seconds, and then names the
 * processes still running from it.
 */
async function removeTree(path: string): Promise<void> {
  for (let waited = 0; ; waited += 250) {
    try {
      rmSync(path, { force: true, recursive: true })
      return
    }
    catch (error) {
      if (process.platform !== 'win32' || waited >= 15_000) {
        const holders = process.platform === 'win32' ? describeProcesses() : ''
        throw new Error(`${(error as Error).message}${holders ? `\nprocesses now:\n${holders}` : ''}`, { cause: error })
      }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }
}

function describeProcesses(): string {
  const listed = spawnSync('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Where-Object { $_.Name -match "node|cmd|conhost" } | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CommandLine)" }'], { encoding: 'utf8' })
  return `${listed.stdout ?? ''}${listed.stderr ?? ''}`.trim()
}

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

  afterEach(async () => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    await removeTree(root)
  }, 20_000)

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

    expect(findings.filter(entry => entry.status !== 'ok')).toEqual([])
    expect(findings.map(entry => entry.check)).toEqual([
      'version',
      'path',
      'binding',
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

    const binding = finding(await doctor(), 'binding')

    expect(binding.status).toBe('fail')
    expect(binding.fix).toMatch(/kanbo init/)
  })

  it('fails a stale instruction block and says how to rewrite it', async () => {
    installKanbo('process.exit(1)')
    const path = join(projectDir, 'CLAUDE.md')
    writeFileSync(path, readFileSync(path, 'utf8').replace('Take a card', 'Grab a card'))

    const instructions = finding(await doctor(), 'instructions')

    expect(instructions.status).toBe('fail')
    expect(instructions.detail).toContain('stale')
    expect(instructions.fix).toContain('kanbo init --instructions claude --yes')
  })

  it('fails an MCP registration whose command is not on PATH', async () => {
    installKanbo('process.exit(1)')
    const path = join(projectDir, '.mcp.json')
    writeFileSync(path, readFileSync(path, 'utf8').replace('"command": "kanbo"', '"command": "kanbo-nowhere"'))

    const claude = finding(await doctor(), 'mcp:claude')

    expect(claude.status).toBe('fail')
    expect(claude.detail).toContain('kanbo-nowhere')
    expect(claude.fix).toBeDefined()
    expect(finding(await doctor(), 'mcp:codex').status).toBe('ok')
  })

  it('checks both the Node and the script of a registration that names them by full path', async () => {
    installKanbo('process.exit(1)')
    const script = join(root, 'kanbo-dist', 'cli.cjs')
    const path = join(projectDir, '.cursor', 'mcp.json')
    const register = (command: string) => writeFileSync(path, JSON.stringify({
      mcpServers: { kanbo: { type: 'stdio', command, args: [script, 'mcp'] } },
    }))

    register(process.execPath)
    const missingScript = finding(await doctor(), 'mcp:cursor')
    expect(missingScript.status).toBe('fail')
    expect(missingScript.detail).toContain(script)
    expect(missingScript.fix).toBe('Run kanbo doctor --fix to point it at this kanbo.')

    mkdirSync(dirname(script), { recursive: true })
    writeFileSync(script, '')
    expect(finding(await doctor(), 'mcp:cursor').status).toBe('ok')

    register(join(root, 'old-node', 'node.exe'))
    const missingNode = finding(await doctor(), 'mcp:cursor')
    expect(missingNode.status).toBe('fail')
    expect(missingNode.detail).toContain(join(root, 'old-node', 'node.exe'))
  })

  it('fails a board file older than this build and points at kanbo migrate', async () => {
    installKanbo('process.exit(1)')
    const database = new SqliteDriver(join(projectDir, '.kanbo', 'board.db'))
    database.prepare('update kanban_meta set revision = 0 where key = \'schema_epoch\'').run()
    database.close()

    const board = finding(await doctor(), 'board')

    expect(board.status).toBe('fail')
    expect(board.fix).toBe('Run kanbo migrate.')
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
    expect(finding(report.findings, 'binding').status).toBe('fail')
  })
})

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { writeRecordingBin } from '../testing/fake-bin'
import { registerInitCommand } from './commands/init'
import { GLOBAL_INSTRUCTION_BLOCK, INSTRUCTION_BLOCK } from './setup/instructions'
import { LEGACY_BLOCK_BODIES } from './setup/legacy-blocks'
import { claudeUserAddArgv, displayCommand, readCodexMcpEntry } from './setup/mcp-config'
import { mcpLaunchSpec } from './setup/mcp-launch'

const USER_LAUNCH = mcpLaunchSpec({ scope: 'user' })

/**
 * `kanbo init --global` against a home directory of its own: `HOME`,
 * `CODEX_HOME` and `PATH` all point into a temporary folder, so nothing here
 * can reach the real home of whoever runs the tests.
 */
describe('kanbo init --global', () => {
  let root: string
  let home: string
  let codexHome: string
  let bin: string
  let projectDir: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kanbo-global-'))
    home = join(root, 'home')
    codexHome = join(root, 'codex-home')
    bin = join(root, 'bin')
    projectDir = join(root, 'project')
    for (const directory of [home, bin, projectDir]) {
      mkdirSync(directory, { recursive: true })
    }
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    vi.stubEnv('CODEX_HOME', codexHome)
    vi.stubEnv('PATH', bin)
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    rmSync(root, { force: true, recursive: true })
  })

  async function run(argv: string[]): Promise<Record<string, unknown>> {
    const printed: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      printed.push(String(line))
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const program = new Command().exitOverride()
    registerInitCommand(program)
    await program.parseAsync(['init', '--global', '--format', 'json', ...argv], { from: 'user' })
    return JSON.parse(printed.at(-1)!) as Record<string, unknown>
  }

  it('writes the global block and the MCP registrations into the temp home, and binds no board', async () => {
    const result = await run(['--yes'])

    const claudeMd = readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8')
    expect(claudeMd).toContain(GLOBAL_INSTRUCTION_BLOCK)
    expect(claudeMd).not.toContain(INSTRUCTION_BLOCK)
    expect(readFileSync(join(codexHome, 'AGENTS.md'), 'utf8')).toContain(GLOBAL_INSTRUCTION_BLOCK)
    expect(existsSync(join(home, '.gemini', 'GEMINI.md'))).toBe(false)
    // `kanbo mcp`, or on Windows this Node and this script (mcp-launch.test.ts has both forms).
    expect(readCodexMcpEntry(join(codexHome, 'config.toml'))).toEqual({ ...USER_LAUNCH, otherFields: [] })
    expect(JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8'))).toEqual({
      mcpServers: { kanbo: { type: 'stdio', ...USER_LAUNCH } },
    })

    // Claude Code is not on this PATH: the line is handed to the person.
    expect(result.mcp).toContainEqual(expect.objectContaining({
      client: 'claude',
      state: 'manual',
      command: displayCommand(claudeUserAddArgv(USER_LAUNCH)),
    }))
    expect(existsSync(join(home, '.claude.json'))).toBe(false)

    // No board, no binding, nothing in the folder it was run from.
    expect(readdirSync(projectDir)).toEqual([])
  })

  it('reports every file unchanged the second time', async () => {
    await run(['--yes', '--mcp', 'codex,cursor', '--instructions', 'claude,codex,gemini'])
    const second = await run(['--yes', '--mcp', 'codex,cursor', '--instructions', 'claude,codex,gemini'])

    expect(second.instructions).toEqual([
      expect.objectContaining({ client: 'claude', state: 'unchanged' }),
      expect.objectContaining({ client: 'codex', state: 'unchanged' }),
      expect.objectContaining({ client: 'gemini', state: 'unchanged' }),
    ])
    expect(second.mcp).toEqual([
      expect.objectContaining({ client: 'codex', state: 'unchanged' }),
      expect.objectContaining({ client: 'cursor', state: 'unchanged' }),
    ])
  })

  it('rewrites a stale block and keeps the person\'s own writing around it', async () => {
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(
      join(home, '.claude', 'CLAUDE.md'),
      `# Mine\n\n<!-- KANBO_START -->\n${LEGACY_BLOCK_BODIES[2]}\n<!-- KANBO_END -->\n\nMore of mine.\n`,
    )

    const result = await run(['--yes', '--instructions', 'claude', '--mcp', ''])

    expect(result.instructions).toEqual([expect.objectContaining({ state: 'written' })])
    expect(readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8'))
      .toBe(`# Mine\n\n${GLOBAL_INSTRUCTION_BLOCK}\n\nMore of mine.\n`)
  })

  it('runs claude mcp add when Claude Code is on PATH', async () => {
    const calls = join(root, 'claude-calls')
    writeRecordingBin(bin, 'claude', calls)
    // The fake is a node script, and node is what runs it.
    vi.stubEnv('PATH', [bin, dirname(process.execPath)].join(delimiter))

    const result = await run(['--yes', '--instructions', 'none', '--mcp', 'claude'])

    expect(readFileSync(calls, 'utf8')).toBe(`${claudeUserAddArgv(USER_LAUNCH).slice(1).join(' ')}\n`)
    expect(result.mcp).toEqual([expect.objectContaining({ client: 'claude', state: 'written' })])
  })

  it('writes nothing from a shell nobody can ask, without --yes', async () => {
    await expect(run([])).rejects.toThrowError(/--yes/)
    expect(existsSync(join(home, '.claude'))).toBe(false)
    expect(existsSync(codexHome)).toBe(false)
  })

  it('refuses the flags that bind a project', async () => {
    await expect(run(['--yes', '--file'])).rejects.toThrowError(/--global connects no board/)
    expect(readdirSync(projectDir)).toEqual([])
  })
})

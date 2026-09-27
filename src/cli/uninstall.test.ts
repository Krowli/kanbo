import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { writeRecordingBin } from '../testing/fake-bin'
import { createPromptDriver } from '../testing/prompt-driver'
import { registerInitCommand } from './commands/init'
import { registerUninstallCommand } from './commands/uninstall'
import { GLOBAL_INSTRUCTION_BLOCK, INSTRUCTION_BLOCK } from './setup/instructions'
import { setUiForTests } from './ui/ui'

/** The one question `--purge` asks, answered by the test. */
const prompts = { confirm: vi.fn() }

/**
 * `kanbo uninstall` on a project and a home directory set up by `kanbo init`,
 * with the person's own content around everything kanbo wrote. `HOME`,
 * `CODEX_HOME` and `PATH` point into a temporary folder; the `claude` on that
 * PATH only writes down what it was asked.
 */
describe('kanbo uninstall', () => {
  let root: string
  let home: string
  let codexHome: string
  let projectDir: string
  let claudeCalls: string

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'kanbo-uninstall-'))
    home = join(root, 'home')
    codexHome = join(root, 'codex-home')
    projectDir = join(root, 'project')
    const bin = join(root, 'bin')
    claudeCalls = join(root, 'claude-calls')
    for (const directory of [home, bin, projectDir, codexHome, join(home, '.claude'), join(projectDir, '.codex')]) {
      mkdirSync(directory, { recursive: true })
    }
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    vi.stubEnv('CODEX_HOME', codexHome)
    // The fake `claude` below is a node script, and node is what runs it.
    vi.stubEnv('PATH', [bin, dirname(process.execPath)].join(delimiter))
    for (const name of ['KANBO_DB_PATH', 'KANBO_DATABASE_URL', 'KANBO_WORKSPACE_ID']) {
      vi.stubEnv(name, undefined)
    }
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    prompts.confirm.mockReset()

    // The person's own content, there before kanbo.
    writeFileSync(join(projectDir, 'CLAUDE.md'), '# Project notes\n')
    writeFileSync(join(projectDir, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'other' } } }))
    writeFileSync(join(projectDir, '.codex', 'config.toml'), '[mcp_servers.other]\ncommand = "other"\n')
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), '# Mine\n')
    writeFileSync(join(codexHome, 'config.toml'), 'model = "o3"\n')

    await runInit(['--file', '--instructions', 'claude', '--mcp', 'claude,codex,cursor', '--yes'])
    await runInit(['--global', '--mcp', 'codex,cursor', '--yes'])

    // Claude Code's user-scope registration, as `claude mcp add` leaves it.
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { kanbo: { command: 'kanbo', args: ['mcp'] } } }))
    writeRecordingBin(bin, 'claude', claudeCalls)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    setUiForTests(null)
    rmSync(root, { force: true, recursive: true })
  })

  async function runInit(argv: string[]): Promise<void> {
    const program = new Command().exitOverride()
    registerInitCommand(program)
    await program.parseAsync(['init', ...argv], { from: 'user' })
  }

  async function uninstall(argv: string[]): Promise<void> {
    const program = new Command().exitOverride()
    registerUninstallCommand(program)
    await program.parseAsync(['uninstall', ...argv], { from: 'user' })
  }

  function read(...path: string[]): string {
    return readFileSync(join(...path), 'utf8')
  }

  it('takes out every block and kanbo entry, and leaves everything else as it was', async () => {
    expect(read(projectDir, 'CLAUDE.md')).toContain(INSTRUCTION_BLOCK)
    expect(read(home, '.claude', 'CLAUDE.md')).toContain(GLOBAL_INSTRUCTION_BLOCK)

    await uninstall(['--yes'])

    expect(read(projectDir, 'CLAUDE.md')).toBe('# Project notes\n')
    expect(JSON.parse(read(projectDir, '.mcp.json'))).toEqual({ mcpServers: { other: { command: 'other' } } })
    expect(read(projectDir, '.codex', 'config.toml')).toBe('[mcp_servers.other]\ncommand = "other"\n')
    expect(JSON.parse(read(projectDir, '.cursor', 'mcp.json'))).toEqual({ mcpServers: {} })
    expect(read(home, '.claude', 'CLAUDE.md')).toBe('# Mine\n')
    expect(read(codexHome, 'AGENTS.md')).toBe('')
    expect(read(codexHome, 'config.toml')).toBe('model = "o3"\n')
    expect(JSON.parse(read(home, '.cursor', 'mcp.json'))).toEqual({ mcpServers: {} })
    expect(read(claudeCalls)).toBe('mcp remove kanbo --scope user\n')

    // The board and its binding are not what uninstall is for.
    expect(existsSync(join(projectDir, '.kanbo', 'binding.json'))).toBe(true)
    expect(existsSync(join(projectDir, '.kanbo', 'board.db'))).toBe(true)
  })

  it('touches only the project with --project', async () => {
    await uninstall(['--project', '--yes'])

    expect(read(projectDir, 'CLAUDE.md')).toBe('# Project notes\n')
    expect(read(home, '.claude', 'CLAUDE.md')).toContain(GLOBAL_INSTRUCTION_BLOCK)
    expect(read(codexHome, 'config.toml')).toContain('[mcp_servers.kanbo]')
    expect(existsSync(claudeCalls)).toBe(false)
  })

  it('removes the binding with --purge --yes, and keeps the board file it cannot ask about', async () => {
    await uninstall(['--project', '--purge', '--yes'])

    expect(existsSync(join(projectDir, '.kanbo', 'binding.json'))).toBe(false)
    expect(existsSync(join(projectDir, '.kanbo', 'board.db'))).toBe(true)
    expect(prompts.confirm).not.toHaveBeenCalled()
  })

  it('deletes the board file only on a yes to a question that names it', async () => {
    // A terminal, as `canPrompt` sees one.
    setUiForTests({ ...createPromptDriver().ui, confirm: prompts.confirm })
    for (const name of ['CI', 'TERM', 'KANBO_ACTOR_KIND']) {
      vi.stubEnv(name, undefined)
    }
    const board = join(projectDir, '.kanbo', 'board.db')

    prompts.confirm.mockResolvedValueOnce(false)
    await uninstall(['--project', '--purge', '--yes'])
    expect(prompts.confirm).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining(board) }))
    expect(existsSync(board)).toBe(true)

    // The binding is gone now, so the board is found the way the binding named it — write it back.
    await runInit(['--file', '--instructions', 'none', '--mcp', '', '--yes'])
    prompts.confirm.mockResolvedValueOnce(true)
    await uninstall(['--project', '--purge', '--yes'])
    expect(existsSync(board)).toBe(false)
  })

  it('changes nothing from a shell nobody can ask, without --yes', async () => {
    await expect(uninstall([])).rejects.toThrowError(/--yes/)

    expect(read(projectDir, 'CLAUDE.md')).toContain(INSTRUCTION_BLOCK)
    expect(read(home, '.claude', 'CLAUDE.md')).toContain(GLOBAL_INSTRUCTION_BLOCK)
  })

  it('refuses --purge with --global alone', async () => {
    await expect(uninstall(['--global', '--purge', '--yes'])).rejects.toThrowError(/--purge/)
    expect(existsSync(join(projectDir, '.kanbo', 'binding.json'))).toBe(true)
  })
})

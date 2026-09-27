import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { writeFakeBin } from '../testing/fake-bin'
import { createPromptDriver } from '../testing/prompt-driver'
import { registerConnectCommand } from './commands/connect'
import { detectAgents } from './setup/agents'
import { GLOBAL_INSTRUCTION_BLOCK, INSTRUCTION_BLOCK } from './setup/instructions'
import { readCodexMcpEntry } from './setup/mcp-config'
import { mcpLaunchSpec } from './setup/mcp-launch'
import { CancelledError, setUiForTests } from './ui/ui'

/** Every file under a folder with its bytes, to show a command left it exactly as it was. */
function snapshot(directory: string): Record<string, string> {
  const files: Record<string, string> = {}
  const walk = (folder: string): void => {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name)
      if (statSync(path).isDirectory()) {
        files[`${path}/`] = ''
        walk(path)
      }
      else {
        files[path] = readFileSync(path, 'base64')
      }
    }
  }
  walk(directory)
  return files
}

/** Run the tests' code as if on another OS, for the parts that follow `process.platform`. */
function onPlatform(platform: NodeJS.Platform): void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...original, value: platform })
  restorePlatform = () => Object.defineProperty(process, 'platform', original)
}
let restorePlatform: (() => void) | null = null

/**
 * `kanbo connect` against a project and a home of their own: `HOME`,
 * `CODEX_HOME` and `PATH` point into a temporary folder, and no `claude` is on
 * that PATH, so Claude Code's own registration is only ever handed back.
 */
describe('kanbo connect', () => {
  let root: string
  let home: string
  let codexHome: string
  let bin: string
  let projectDir: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kanbo-connect-'))
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
    for (const name of ['CLAUDE_CONFIG_DIR', 'GEMINI_CLI_HOME', 'LOCALAPPDATA', 'KANBO_ACTOR_KIND', 'CI', 'TERM']) {
      vi.stubEnv(name, undefined)
    }
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir)
  })

  afterEach(() => {
    restorePlatform?.()
    restorePlatform = null
    setUiForTests(null)
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    rmSync(root, { force: true, recursive: true })
  })

  /** Run `kanbo connect …`; returns what it printed to stdout. */
  async function connect(...argv: string[]): Promise<string> {
    const printed: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      printed.push(String(line))
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const program = new Command().exitOverride()
    registerConnectCommand(program)
    await program.parseAsync(['connect', ...argv], { from: 'user' })
    return printed.join('\n')
  }

  const read = (...parts: string[]): string => readFileSync(join(...parts), 'utf8')

  describe('finding the agents a person uses', () => {
    it('knows each agent by its command on PATH, its own folder, or a file of its own in the project', () => {
      writeFakeBin(bin, 'codex', 'process.exit(0)')
      mkdirSync(join(home, '.gemini'))
      mkdirSync(join(projectDir, '.cursor'))
      vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'claude-elsewhere'))

      // Linux's rules on a POSIX machine, so no app folder of the machine running the tests counts.
      const platform = process.platform === 'win32' ? 'win32' : 'linux'
      const found = Object.fromEntries(detectAgents({ projectDir, platform }).map(entry => [entry.agent, entry]))

      expect(found.claude!.detected).toBe(false)
      expect(found.codex!.evidence).toEqual([join(bin, platform === 'win32' ? 'codex.cmd' : 'codex')])
      expect(found.gemini!.evidence).toEqual([join(home, '.gemini')])
      expect(found.cursor!.evidence).toEqual([join(projectDir, '.cursor')])

      mkdirSync(join(root, 'claude-elsewhere'))
      expect(detectAgents({ projectDir, platform })[0]!.evidence).toEqual([join(root, 'claude-elsewhere')])
    })

    it('finds Cursor installed for the user on Windows, and a .cmd on PATH by PATHEXT', () => {
      vi.stubEnv('LOCALAPPDATA', join(root, 'local'))
      mkdirSync(join(root, 'local', 'Programs', 'cursor'), { recursive: true })
      writeFakeBin(bin, 'gemini', 'process.exit(0)', 'win32')

      const found = Object.fromEntries(detectAgents({ projectDir, platform: 'win32', env: { ...process.env, PATHEXT: '.CMD' } })
        .map(entry => [entry.agent, entry.evidence]))

      expect(found.cursor).toEqual([join(root, 'local', 'Programs', 'cursor')])
      expect(found.gemini).toEqual([join(bin, 'gemini.cmd')])
    })
  })

  it.skipIf(process.platform === 'win32')('connect claude --yes writes the kanbo section into CLAUDE.md and the server into .mcp.json', async () => {
    writeFileSync(join(projectDir, 'CLAUDE.md'), '# Notes\n')

    await connect('claude', '--yes')

    expect(read(projectDir, 'CLAUDE.md')).toBe(`# Notes\n\n${INSTRUCTION_BLOCK}\n`)
    expect(JSON.parse(read(projectDir, '.mcp.json'))).toEqual({
      mcpServers: { kanbo: { type: 'stdio', command: 'kanbo', args: ['mcp'] } },
    })
    expect(existsSync(join(home, '.claude.json'))).toBe(false)
  })

  it('on Windows registers every agent in the person\'s own settings by default, as this Node and this script', async () => {
    onPlatform('win32')
    const launch = mcpLaunchSpec({ scope: 'user', platform: 'win32' })

    const printed = await connect('cursor', 'gemini', 'codex', 'claude', '--no-instructions', '--yes')

    expect(JSON.parse(read(home, '.cursor', 'mcp.json'))).toEqual({ mcpServers: { kanbo: { type: 'stdio', ...launch } } })
    expect(JSON.parse(read(home, '.gemini', 'settings.json'))).toEqual({ mcpServers: { kanbo: launch } })
    expect(readCodexMcpEntry(join(codexHome, 'config.toml'))).toEqual(launch)
    // Claude Code's user settings change only through `claude mcp add`, which is not on this PATH.
    expect(printed).toContain('claude mcp add --scope user kanbo --')
    expect(readdirSync(projectDir)).toEqual([])
  })

  it('keeps the shared AGENTS.md section while Codex still uses it, and removes it with the last one', async () => {
    await connect('codex', 'cursor', '--yes')
    expect(read(projectDir, 'AGENTS.md')).toBe(`${INSTRUCTION_BLOCK}\n`)
    const cursorMcp = process.platform === 'win32' ? join(home, '.cursor', 'mcp.json') : join(projectDir, '.cursor', 'mcp.json')
    expect(read(cursorMcp)).toContain('"kanbo"')

    await connect('cursor', '--remove', '--yes')

    expect(read(projectDir, 'AGENTS.md')).toBe(`${INSTRUCTION_BLOCK}\n`)
    expect(JSON.parse(read(cursorMcp))).toEqual({ mcpServers: {} })
    expect(readCodexMcpEntry(join(codexHome, 'config.toml'))).toBeDefined()

    await connect('codex', '--remove', '--yes')

    expect(read(projectDir, 'AGENTS.md')).toBe('')
    expect(readCodexMcpEntry(join(codexHome, 'config.toml'))).toBeUndefined()
  })

  describe('--check', () => {
    async function check(...argv: string[]): Promise<Record<string, unknown>[]> {
      return JSON.parse(await connect(...argv, '--check', '--json')) as Record<string, unknown>[]
    }

    it('says what each agent has, and exits 1 only when an agent it was asked about is not connected', async () => {
      await connect('claude', '--project', '--yes')

      expect(await check('claude')).toEqual([
        { agent: 'claude', instructions: 'current', mcp: 'ok', scope: 'project', connected: true },
      ])
      const all = await check()
      expect(all.map(row => [row.agent, row.connected])).toEqual([['claude', true], ['codex', false], ['cursor', false], ['gemini', false]])
      await expect(connect('--check', 'claude', 'gemini')).rejects.toThrowError(/Not connected: gemini/)
      await expect(connect('--check', 'gemini')).rejects.toThrowError(expect.objectContaining({ exitCode: 1 }))
    })

    it('tells an old block, an edited one and a registration that no longer starts from a current one', async () => {
      writeFileSync(join(projectDir, 'CLAUDE.md'), '<!-- KANBO_START -->\nold rules\n<!-- KANBO_END -->\n')
      writeFileSync(join(projectDir, '.mcp.json'), JSON.stringify({
        mcpServers: { kanbo: { command: join(root, 'old-node', 'node'), args: [join(root, 'gone', 'cli.cjs'), 'mcp'] } },
      }))
      await connect('gemini', '--project', '--yes')
      writeFileSync(join(projectDir, 'GEMINI.md'), read(projectDir, 'GEMINI.md').replace('Take work', 'Pick work'))

      const rows = await check('--project')

      expect(rows.find(row => row.agent === 'claude')).toMatchObject({ instructions: 'legacy', mcp: 'stale path', connected: false })
      expect(rows.find(row => row.agent === 'gemini')).toMatchObject({ instructions: 'edited', mcp: 'ok', connected: true })
    })
  })

  it('--dry-run shows the plan and writes nothing', async () => {
    writeFileSync(join(projectDir, 'CLAUDE.md'), '# Notes\n')
    const before = snapshot(root)

    const printed = await connect('claude', 'codex', 'cursor', 'gemini', '--dry-run')

    expect(printed).toContain('Dry run: nothing was changed.')
    expect(snapshot(root)).toEqual(before)
  })

  it('rewrites a kanbo entry of its own that no longer starts, and leaves one the person pointed elsewhere', async () => {
    const stale = { command: join(root, 'old-node', 'node.exe'), args: [join(root, 'gone', 'cli.cjs'), 'mcp'] }
    writeFileSync(join(projectDir, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'other' }, kanbo: stale } }))
    mkdirSync(codexHome)
    writeFileSync(join(codexHome, 'config.toml'), `model = "o3"\n\n[mcp_servers.kanbo]\ncommand = ${JSON.stringify(stale.command)}\nargs = ${JSON.stringify(stale.args)}\n\n[profiles.x]\nmodel = "o4"\n`)
    mkdirSync(join(projectDir, '.cursor'))
    const own = { mcpServers: { kanbo: { command: 'my-kanbo', args: ['mcp', '--verbose'] } } }
    writeFileSync(join(projectDir, '.cursor', 'mcp.json'), JSON.stringify(own))

    await connect('claude', 'cursor', '--project', '--no-instructions', '--yes')
    await connect('codex', '--global', '--no-instructions', '--yes')

    expect(JSON.parse(read(projectDir, '.mcp.json'))).toEqual({
      mcpServers: { other: { command: 'other' }, kanbo: { type: 'stdio', command: 'kanbo', args: ['mcp'] } },
    })
    const toml = read(codexHome, 'config.toml')
    expect(readCodexMcpEntry(join(codexHome, 'config.toml'))).toEqual(mcpLaunchSpec({ scope: 'user' }))
    expect(toml.match(/\[mcp_servers\.kanbo\]/g)).toHaveLength(1)
    expect(toml.startsWith('model = "o3"\n\n[mcp_servers.kanbo]\n')).toBe(true)
    expect(toml.endsWith('\n\n[profiles.x]\nmodel = "o4"\n')).toBe(true)
    expect(JSON.parse(read(projectDir, '.cursor', 'mcp.json'))).toEqual(own)
  })

  it('writes Gemini CLI\'s entry without a type, beside the settings already there', async () => {
    mkdirSync(join(projectDir, '.gemini'))
    writeFileSync(join(projectDir, '.gemini', 'settings.json'), JSON.stringify({ theme: 'Dracula' }))

    await connect('gemini', '--project', '--yes')

    expect(JSON.parse(read(projectDir, '.gemini', 'settings.json'))).toEqual({
      theme: 'Dracula',
      mcpServers: { kanbo: { command: 'kanbo', args: ['mcp'] } },
    })
    expect(read(projectDir, 'GEMINI.md')).toBe(`${INSTRUCTION_BLOCK}\n`)
  })

  it('--global writes the global section into each agent\'s own file, and tells how to add it to Cursor', async () => {
    const printed = await connect('claude', 'cursor', '--global', '--no-mcp', '--yes')

    expect(read(home, '.claude', 'CLAUDE.md')).toBe(`${GLOBAL_INSTRUCTION_BLOCK}\n`)
    expect(printed).toContain('Cursor Settings → Rules')
    expect(readdirSync(projectDir)).toEqual([])
  })

  it('without agents and without a terminal, names the agents it knows instead of asking', async () => {
    await expect(connect('--yes')).rejects.toThrowError(/claude, codex, cursor, gemini/)
    await expect(connect('copilot')).rejects.toThrowError(/Unknown agent "copilot"/)
  })

  describe('asked at a terminal', () => {
    beforeEach(() => {
      // Detection looks for /Applications/Cursor.app on macOS; the machine running the tests may have it.
      if (process.platform === 'darwin') {
        onPlatform('linux')
      }
    })

    it('picks agents, lets a file be unticked, and writes the rest after a yes', async () => {
      const driver = createPromptDriver()
      setUiForTests(driver.ui)
      const running = connect()

      await driver.waitFor('Which agents do you use?')
      driver.press('space', 'enter')
      await driver.waitFor('Which of these should kanbo change?')
      driver.press('down', 'space', 'enter')
      await driver.waitFor('Make these changes?')
      driver.press('enter')
      await running.catch((error) => { throw new Error(`${String(error)}\n${driver.transcript()}`) })

      expect(read(projectDir, 'CLAUDE.md')).toBe(`${INSTRUCTION_BLOCK}\n`)
      expect(existsSync(join(projectDir, '.mcp.json'))).toBe(false)
      expect(existsSync(join(home, '.claude.json'))).toBe(false)
    })

    it('leaves every file byte for byte as it was when stopped at the last question', async () => {
      writeFileSync(join(projectDir, 'CLAUDE.md'), '# Notes\r\n')
      const before = snapshot(root)
      const driver = createPromptDriver()
      setUiForTests(driver.ui)
      const running = connect()

      await driver.waitFor('Which agents do you use?')
      // Claude is ticked already: CLAUDE.md is in the project.
      driver.press('down', 'space', 'enter')
      await driver.waitFor('Which of these should kanbo change?')
      driver.press('enter')
      await driver.waitFor('Make these changes?')
      driver.press('ctrl-c')

      await expect(running).rejects.toBeInstanceOf(CancelledError)
      expect(snapshot(root)).toEqual(before)
    })
  })
})

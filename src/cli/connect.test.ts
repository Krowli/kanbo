import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { writeFakeBin, writeRecordingBin } from '../testing/fake-bin'
import { createPromptDriver } from '../testing/prompt-driver'
import { registerConnectCommand } from './commands/connect'
import { detectAgents } from './setup/agents'
import { GLOBAL_INSTRUCTION_BLOCK, INSTRUCTION_BLOCK, wrapInstructionBlock } from './setup/instructions'
import { claudeUserAddArgv, displayCommand, readCodexMcpEntry } from './setup/mcp-config'
import { mcpLaunchSpec } from './setup/mcp-launch'
import { CancelledError, setUiForTests } from './ui/ui'

/** A project's `CLAUDE.md` exactly as `kanbo init --instructions claude` 0.2.1 left it. */
const CLAUDE_MD_0_2_1 = readFileSync(join(import.meta.dirname, 'setup', 'fixtures', 'claude-md-0.2.1.md'), 'utf8')

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

  it('connect claude --yes registers the server for the user with claude mcp add, and writes no CLAUDE.md', async () => {
    const calls = join(root, 'claude-calls')
    writeRecordingBin(bin, 'claude', calls)
    vi.stubEnv('PATH', [bin, dirname(process.execPath)].join(delimiter))

    await connect('claude', '--yes')

    expect(readFileSync(calls, 'utf8')).toBe('mcp add --scope user kanbo -- kanbo mcp\n')
    expect(existsSync(join(projectDir, 'CLAUDE.md'))).toBe(false)
    expect(readdirSync(projectDir)).toEqual([])
  })

  it('registers every agent in the person\'s own settings by default, as this Node and this script', async () => {
    const launch = mcpLaunchSpec({ scope: 'user' })

    const printed = await connect('cursor', 'gemini', 'codex', 'claude', '--yes')

    expect(JSON.parse(read(home, '.cursor', 'mcp.json'))).toEqual({ mcpServers: { kanbo: { type: 'stdio', ...launch } } })
    expect(JSON.parse(read(home, '.gemini', 'settings.json'))).toEqual({ mcpServers: { kanbo: launch } })
    expect(readCodexMcpEntry(join(codexHome, 'config.toml'))).toEqual({ ...launch, otherFields: [] })
    // Claude Code's user settings change only through `claude mcp add`, which is not on this PATH.
    expect(printed).toContain('claude mcp add --scope user kanbo --')
    expect(readdirSync(projectDir)).toEqual([])
  })

  it('--project writes the project\'s own files: .cursor/mcp.json, and no AGENTS.md', async () => {
    await connect('cursor', '--project', '--yes')

    expect(JSON.parse(read(projectDir, '.cursor', 'mcp.json'))).toEqual({
      mcpServers: { kanbo: { type: 'stdio', command: 'kanbo', args: ['mcp'] } },
    })
    expect(existsSync(join(projectDir, 'AGENTS.md'))).toBe(false)
  })

  it('takes the v3 section out of a project\'s CLAUDE.md and of the global one, keeping the rest of each file byte for byte', async () => {
    const claudeDir = join(root, 'claude-config')
    mkdirSync(claudeDir)
    vi.stubEnv('CLAUDE_CONFIG_DIR', claudeDir)
    writeFileSync(join(projectDir, 'CLAUDE.md'), `# Notes\n\nbefore\n\n${INSTRUCTION_BLOCK}\n\nafter\n`)
    writeFileSync(join(claudeDir, 'CLAUDE.md'), `# Mine\n\n${GLOBAL_INSTRUCTION_BLOCK}\n\nMore of mine.\n`)

    const printed = await connect('claude', '--yes')

    expect(read(projectDir, 'CLAUDE.md')).toBe('# Notes\n\nbefore\n\nafter\n')
    expect(read(claudeDir, 'CLAUDE.md')).toBe('# Mine\n\nMore of mine.\n')
    expect(printed).toContain('CLAUDE.md (the old kanbo section: agents now learn the board from the MCP server)')
  })

  it('keeps a section the person edited, and says kanbo no longer uses it', async () => {
    const edited = `# Mine\n\n${INSTRUCTION_BLOCK.replace('Take work with', 'Pick work with')}\n`
    writeFileSync(join(projectDir, 'CLAUDE.md'), edited)

    const printed = await connect('claude', '--yes')

    expect(read(projectDir, 'CLAUDE.md')).toBe(edited)
    expect(printed).toContain('CLAUDE.md: an old kanbo section is still there; kanbo no longer uses it. Delete it yourself, or run kanbo connect --remove.')
  })

  it('says what it removes before it does: the old section, once for two agents that share AGENTS.md', async () => {
    writeFileSync(join(projectDir, 'AGENTS.md'), `${INSTRUCTION_BLOCK}\n`)

    const printed = await connect('codex', 'cursor', '--dry-run')

    expect(printed).toContain('remove  AGENTS.md (the old kanbo section: agents now learn the board from the MCP server)')
    expect(printed.split('remove  AGENTS.md')).toHaveLength(2)
    expect(read(projectDir, 'AGENTS.md')).toBe(`${INSTRUCTION_BLOCK}\n`)
  })

  it('no longer takes --no-instructions or --no-mcp', async () => {
    await expect(connect('claude', '--no-instructions', '--yes')).rejects.toThrowError(expect.objectContaining({ exitCode: 1 }))
    await expect(connect('claude', '--no-mcp', '--yes')).rejects.toThrowError(expect.objectContaining({ exitCode: 1 }))
  })

  it('keeps the shared AGENTS.md section while Codex still uses it, and removes it with the last one', async () => {
    await connect('codex', 'cursor', '--yes')
    writeFileSync(join(projectDir, 'AGENTS.md'), `${INSTRUCTION_BLOCK}\n`)
    const cursorMcp = join(home, '.cursor', 'mcp.json')
    expect(read(cursorMcp)).toContain('"kanbo"')

    await connect('cursor', '--remove', '--yes')

    expect(read(projectDir, 'AGENTS.md')).toBe(`${INSTRUCTION_BLOCK}\n`)
    expect(JSON.parse(read(cursorMcp))).toEqual({ mcpServers: {} })
    expect(readCodexMcpEntry(join(codexHome, 'config.toml'))).toBeDefined()

    await connect('codex', 'cursor', '--remove', '--yes')

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
        { agent: 'claude', mcp: 'ok', scope: 'project', connected: true, oldSections: [] },
      ])
      const all = await check()
      expect(all.map(row => [row.agent, row.connected])).toEqual([['claude', true], ['codex', false], ['cursor', false], ['gemini', false]])
      await expect(connect('--check', 'claude', 'gemini')).rejects.toThrowError(/Not connected: gemini/)
      await expect(connect('--check', 'gemini')).rejects.toThrowError(expect.objectContaining({ exitCode: 1 }))
    })

    it('calls the registration Claude Code writes itself (with an empty env) ok, not yours', async () => {
      writeFileSync(join(home, '.claude.json'), JSON.stringify({
        mcpServers: { kanbo: { type: 'stdio', command: 'kanbo', args: ['mcp'], env: {} } },
      }))

      const rows = await check('--global')

      expect(rows.find(row => row.agent === 'claude')).toMatchObject({ mcp: 'ok', scope: 'user' })
    })

    it('tells a registration that no longer starts from a current one, and lists the files with an old section', async () => {
      writeFileSync(join(projectDir, 'CLAUDE.md'), CLAUDE_MD_0_2_1)
      writeFileSync(join(projectDir, '.mcp.json'), JSON.stringify({
        mcpServers: { kanbo: { command: join(root, 'old-node', 'node'), args: [join(root, 'gone', 'kanbo-cli', 'dist', 'cli.cjs'), 'mcp'] } },
      }))
      await connect('gemini', '--project', '--yes')

      const rows = await check('--project')

      expect(rows.find(row => row.agent === 'claude')).toMatchObject({ mcp: 'stale path', connected: false, oldSections: [join(projectDir, 'CLAUDE.md')] })
      expect(rows.find(row => row.agent === 'gemini')).toMatchObject({ mcp: 'ok', connected: true, oldSections: [] })
      expect(await connect('--project', '--check')).toContain(`old kanbo section in ${join(projectDir, 'CLAUDE.md')} — kanbo connect removes it`)
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
    const stale = { command: join(root, 'old-node', 'node.exe'), args: [join(root, 'gone', 'kanbo-cli', 'dist', 'cli.cjs'), 'mcp'] }
    writeFileSync(join(projectDir, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'other' }, kanbo: stale } }))
    mkdirSync(codexHome)
    writeFileSync(join(codexHome, 'config.toml'), `model = "o3"\n\n[mcp_servers.kanbo]\ncommand = ${JSON.stringify(stale.command)}\nargs = ${JSON.stringify(stale.args)}\n\n[profiles.x]\nmodel = "o4"\n`)
    mkdirSync(join(projectDir, '.cursor'))
    const own = { mcpServers: { kanbo: { command: 'my-kanbo', args: ['mcp', '--verbose'] } } }
    writeFileSync(join(projectDir, '.cursor', 'mcp.json'), JSON.stringify(own))

    await connect('claude', 'cursor', '--project', '--yes')
    await connect('codex', '--global', '--yes')

    expect(JSON.parse(read(projectDir, '.mcp.json'))).toEqual({
      mcpServers: { other: { command: 'other' }, kanbo: { type: 'stdio', command: 'kanbo', args: ['mcp'] } },
    })
    const toml = read(codexHome, 'config.toml')
    expect(readCodexMcpEntry(join(codexHome, 'config.toml'))).toEqual({ ...mcpLaunchSpec({ scope: 'user' }), otherFields: [] })
    expect(toml.match(/\[mcp_servers\.kanbo\]/g)).toHaveLength(1)
    expect(toml.startsWith('model = "o3"\n\n[mcp_servers.kanbo]\n')).toBe(true)
    expect(toml.endsWith('\n\n[profiles.x]\nmodel = "o4"\n')).toBe(true)
    expect(JSON.parse(read(projectDir, '.cursor', 'mcp.json'))).toEqual(own)
  })

  it('merges into the servers a project already has, and leaves an entry of its own name alone', async () => {
    writeFileSync(join(projectDir, '.mcp.json'), JSON.stringify({ mcpServers: { other: { type: 'stdio', command: 'other' } } }))
    mkdirSync(join(projectDir, '.codex'))
    writeFileSync(join(projectDir, '.codex', 'config.toml'), 'model = "gpt-5"\n')

    await connect('claude', 'codex', '--project', '--yes')
    const codexAfterFirst = read(projectDir, '.codex', 'config.toml')
    writeFileSync(join(projectDir, '.mcp.json'), read(projectDir, '.mcp.json').replace('"command": "kanbo"', '"command": "kanbo-fork"'))

    await connect('claude', 'codex', '--project', '--yes')

    expect(JSON.parse(read(projectDir, '.mcp.json')).mcpServers.other).toEqual({ type: 'stdio', command: 'other' })
    expect(JSON.parse(read(projectDir, '.mcp.json')).mcpServers.kanbo.command).toBe('kanbo-fork')
    expect(codexAfterFirst).toBe('model = "gpt-5"\n\n[mcp_servers.kanbo]\ncommand = "kanbo"\nargs = ["mcp"]\ndefault_tools_approval_mode = "approve"\n')
    expect(read(projectDir, '.codex', 'config.toml')).toBe(codexAfterFirst)
  })

  it('refuses a tool configuration it cannot merge into, and leaves the file alone', async () => {
    writeFileSync(join(projectDir, '.mcp.json'), '["not an object"]')

    await expect(connect('claude', '--project', '--yes')).rejects.toThrowError(/does not hold a JSON object/)
    expect(read(projectDir, '.mcp.json')).toBe('["not an object"]')
  })

  it('writes Gemini CLI\'s entry without a type, beside the settings already there', async () => {
    mkdirSync(join(projectDir, '.gemini'))
    writeFileSync(join(projectDir, '.gemini', 'settings.json'), JSON.stringify({ theme: 'Dracula' }))

    await connect('gemini', '--project', '--yes')

    expect(JSON.parse(read(projectDir, '.gemini', 'settings.json'))).toEqual({
      theme: 'Dracula',
      mcpServers: { kanbo: { command: 'kanbo', args: ['mcp'] } },
    })
  })

  it('without agents and without a terminal, names the agents it knows instead of asking', async () => {
    await expect(connect('--yes')).rejects.toThrowError(/claude, codex, cursor, gemini/)
    await expect(connect('copilot')).rejects.toThrowError(/Unknown agent "copilot"/)
  })

  describe('an entry or a section that is not in the shape kanbo writes', () => {
    /** Scenario A of the Windows review: Codex started through cmd /c, with an env subtable of the person's. */
    const CODEX_CMD = '[mcp_servers.kanbo]\ncommand = "cmd"\nargs = ["/c", "kanbo", "mcp"]\n\n[mcp_servers.kanbo.env]\nKANBO_ACTOR_ID = "codex"\n'
    /** Scenario B: Cursor started through npx, with an env of the person's. */
    const CURSOR_NPX = { mcpServers: { kanbo: { command: 'npx', args: ['-y', 'kanbo-cli', 'mcp'], env: { KANBO_ACTOR_ID: 'cursor' } } } }
    /** Scenario C: Claude Code's user registration started through cmd /c. */
    const CLAUDE_CMD = { mcpServers: { kanbo: { type: 'stdio', command: 'cmd', args: ['/c', 'kanbo', 'mcp'] } } }

    it('on Windows leaves the person\'s own kanbo entries exactly as they are, and --check says so', async () => {
      mkdirSync(codexHome)
      writeFileSync(join(codexHome, 'config.toml'), CODEX_CMD)
      mkdirSync(join(home, '.cursor'))
      writeFileSync(join(home, '.cursor', 'mcp.json'), JSON.stringify(CURSOR_NPX))
      writeFileSync(join(home, '.claude.json'), JSON.stringify(CLAUDE_CMD))
      const calls = join(root, 'claude-calls')
      writeRecordingBin(bin, 'claude', calls)
      vi.stubEnv('PATH', [bin, dirname(process.execPath)].join(delimiter))
      const before = snapshot(root)
      onPlatform('win32')

      const printed = await connect('codex', 'cursor', 'claude', '--yes')

      expect(snapshot(root)).toEqual(before)
      expect(existsSync(calls)).toBe(false)
      expect(printed).toContain(`Codex: ${join(codexHome, 'config.toml')} has your own kanbo entry — left as is.`)
      expect(printed).toContain(`Cursor: ${join(home, '.cursor', 'mcp.json')} has your own kanbo entry — left as is.`)
      expect(printed).toContain(`Claude Code: ${join(home, '.claude.json')} has your own kanbo entry — left as is.`)

      // npx is on this PATH, as it is wherever Node is: the entry can start, so Cursor counts as connected.
      writeFakeBin(bin, 'npx', 'process.exit(0)', 'win32')
      vi.stubEnv('PATHEXT', '.COM;.EXE;.BAT;.CMD')
      vi.stubEnv('PATH', bin)
      const checked = await connect('cursor', '--global', '--check')
      expect(checked).toContain(`Cursor: ${join(home, '.cursor', 'mcp.json')} has your own kanbo entry — left as is.`)
    })

    it('knows the entry this very kanbo wrote, wherever it runs from, and reports it unchanged', async () => {
      onPlatform('win32')
      await connect('cursor', '--global', '--yes')
      const before = read(home, '.cursor', 'mcp.json')

      const printed = await connect('cursor', '--global', '--yes')

      expect(read(home, '.cursor', 'mcp.json')).toBe(before)
      expect(printed).toContain(`Cursor: ${join(home, '.cursor', 'mcp.json')} (unchanged)`)
      expect(printed).not.toContain('your own kanbo entry')
    })

    it('on Windows rewrites its own stale bare entry and keeps the person\'s other fields', async () => {
      mkdirSync(join(home, '.cursor'))
      writeFileSync(join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { kanbo: { type: 'stdio', command: 'kanbo', args: ['mcp'] } } }))
      onPlatform('win32')

      await connect('cursor', '--yes')

      expect(JSON.parse(read(home, '.cursor', 'mcp.json'))).toEqual({ mcpServers: { kanbo: { type: 'stdio', ...mcpLaunchSpec({ scope: 'user', platform: 'win32' }) } } })
    })

    it('says the old Claude Code entry was removed when claude mcp add fails after it, and prints only the add, alone on its line', async () => {
      writeFileSync(join(home, '.claude.json'), JSON.stringify({
        mcpServers: { kanbo: { command: join(root, 'old-node', 'node'), args: [join(root, 'gone', 'kanbo-cli', 'dist', 'cli.cjs'), 'mcp'] } },
      }))
      writeFakeBin(bin, 'claude', 'if (process.argv[3] === "add") { process.stderr.write("add broke\\n"); process.exit(1) }')
      vi.stubEnv('PATH', [bin, dirname(process.execPath)].join(delimiter))

      const printed = await connect('claude', '--global', '--yes')

      const add = displayCommand(claudeUserAddArgv(mcpLaunchSpec({ scope: 'user' })))
      expect(printed).toContain(`Claude Code: the old kanbo entry was removed, but adding the new one failed (claude exited 1: add broke). Add it yourself:\n  ${add}`)
      const result = printed.slice(printed.indexOf('Claude Code: the old kanbo entry was removed'))
      expect(result).not.toContain('claude mcp remove')
      expect(printed).not.toContain('&&')
    })

    it('leaves a v4 block alone: connect keeps it, --remove without --yes keeps it, --remove --yes takes it out', async () => {
      const newer = `# Mine\n\n${wrapInstructionBlock('## Kanbo board\n\nNewer words.', 4)}\n`
      writeFileSync(join(projectDir, 'CLAUDE.md'), newer)

      const printed = await connect('claude', '--yes')
      expect(read(projectDir, 'CLAUDE.md')).toBe(newer)
      expect(printed).toContain('CLAUDE.md: an old kanbo section is still there; kanbo no longer uses it. Delete it yourself, or run kanbo connect --remove.')

      const kept = await connect('claude', '--remove', '--dry-run')
      expect(read(projectDir, 'CLAUDE.md')).toBe(newer)
      expect(kept).not.toContain('remove  CLAUDE.md')

      await connect('claude', '--remove', '--yes')
      expect(read(projectDir, 'CLAUDE.md')).toBe('# Mine\n')
    })

    it('never touches a file whose start marker has no end, and says how to fix it', async () => {
      const damaged = '# Mine\n\n<!-- KANBO_START v2 h=4842e336 -->\n## Kanbo board\n\nMy notes after the marker.\r\n'
      writeFileSync(join(projectDir, 'CLAUDE.md'), damaged)

      const printed = await connect('claude', '--yes')
      expect(readFileSync(join(projectDir, 'CLAUDE.md'), 'utf8')).toBe(damaged)
      expect(printed).toContain('CLAUDE.md has a kanbo start marker without an end — fix it by hand, then run again.')

      const removed = await connect('claude', '--remove', '--yes')
      expect(readFileSync(join(projectDir, 'CLAUDE.md'), 'utf8')).toBe(damaged)
      expect(removed).toContain('CLAUDE.md has a kanbo start marker without an end')
    })

    it('keeps a block of a text the person chose (an orchestrator text pasted between the markers)', async () => {
      const chosen = `${wrapInstructionBlock('Any orchestrator words.', 2, 'orchestrator')}\n`
      writeFileSync(join(projectDir, 'CLAUDE.md'), chosen)

      const printed = await connect('claude', '--yes')

      expect(read(projectDir, 'CLAUDE.md')).toBe(chosen)
      expect(printed).toContain('CLAUDE.md: an old kanbo section is still there; kanbo no longer uses it.')
    })

    it('refuses to register this kanbo by full path while it runs from the npx cache', async () => {
      const script = join(root, 'npm-cache', '_npx', 'a1b2', 'node_modules', 'kanbo-cli', 'dist', 'cli.cjs')
      mkdirSync(dirname(script), { recursive: true })
      writeFileSync(script, '')
      vi.spyOn(process, 'argv', 'get').mockReturnValue([process.execPath, script, 'connect'])
      onPlatform('win32')

      const printed = await connect('cursor', '--global', '--yes')

      expect(existsSync(join(home, '.cursor', 'mcp.json'))).toBe(false)
      expect(printed).toContain('Install kanbo first so agents can start it: npm install -g kanbo-cli')
    })
  })

  describe('asked at a terminal', () => {
    beforeEach(() => {
      // Detection looks for /Applications/Cursor.app on macOS; the machine running the tests may have it.
      if (process.platform === 'darwin') {
        onPlatform('linux')
      }
    })

    it('picks agents, lets a change be unticked, and makes the rest after a yes', async () => {
      writeFileSync(join(projectDir, 'CLAUDE.md'), `# Notes\n\n${INSTRUCTION_BLOCK}\n`)
      const calls = join(root, 'claude-calls')
      writeRecordingBin(bin, 'claude', calls)
      vi.stubEnv('PATH', [bin, dirname(process.execPath)].join(delimiter))
      const driver = createPromptDriver()
      setUiForTests(driver.ui)
      const running = connect()

      await driver.waitFor('Which agents do you use?')
      // Claude is ticked already: CLAUDE.md is in the project.
      driver.press('enter')
      await driver.waitFor('Which of these should kanbo change?')
      driver.press('down', 'space', 'enter')
      await driver.waitFor('Make these changes?')
      driver.press('enter')
      await running.catch((error) => { throw new Error(`${String(error)}\n${driver.transcript()}`) })

      expect(read(projectDir, 'CLAUDE.md')).toBe('# Notes\n')
      expect(existsSync(calls)).toBe(false)
      expect(existsSync(join(projectDir, '.mcp.json'))).toBe(false)
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

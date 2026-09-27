import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { writeFakeBin, writeRecordingBin } from '../../testing/fake-bin'

import { planInstructionBlock, planInstructionBlockRemoval } from './instructions'
import type { McpEntry } from './mcp-config'
import {
  isOwnMcpEntry,
  isStaleMcpEntry,
  planCodexMcpServer,
  planCodexMcpServerRemoval,
  planJsonMcpServer,
  planJsonMcpServerRemoval,
  readCodexMcpCommand,
  readCodexMcpEntry,
  readJsonMcpEntry,
  runClaudeMcp,
} from './mcp-config'

/**
 * kanbo changes only an entry it wrote itself, in exactly the shape it wrote
 * it; the Windows review's scenarios are all entries of the person's own.
 */
describe('which kanbo entries are kanbo\'s own', () => {
  const entry = (command: string, args: string[], otherFields: string[] = []): McpEntry => ({ command, args, otherFields })
  const NODE = 'C:\\Program Files\\nodejs\\node.exe'
  const SCRIPT = 'C:\\Users\\Ann\\AppData\\Roaming\\npm\\node_modules\\kanbo-cli\\dist\\cli.cjs'

  it('knows the shapes it writes, and nothing else', () => {
    expect(isOwnMcpEntry(entry('kanbo', ['mcp']))).toBe(true)
    expect(isOwnMcpEntry(entry(NODE, [SCRIPT, 'mcp']))).toBe(true)
    expect(isOwnMcpEntry(entry('/usr/local/bin/node', ['/usr/local/lib/node_modules/kanbo-cli/dist/cli-main.cjs', 'mcp']))).toBe(true)

    expect(isOwnMcpEntry(entry('cmd', ['/c', 'kanbo', 'mcp']))).toBe(false)
    expect(isOwnMcpEntry(entry('npx', ['-y', 'kanbo-cli', 'mcp']))).toBe(false)
    expect(isOwnMcpEntry(entry('kanbo', ['mcp'], ['env']))).toBe(false)
    expect(isOwnMcpEntry(entry('kanbo', ['mcp', '--verbose']))).toBe(false)
    expect(isOwnMcpEntry(entry(NODE, ['C:\\tools\\my-kanbo.js', 'mcp']))).toBe(false)
    expect(isOwnMcpEntry(entry('C:\\tools\\bun.exe', [SCRIPT, 'mcp']))).toBe(false)
  })

  it('never calls a Windows entry of the person\'s own stale, however it starts kanbo', () => {
    for (const own of [entry('cmd', ['/c', 'kanbo', 'mcp']), entry('npx', ['-y', 'kanbo-cli', 'mcp']), entry('kanbo', ['mcp'], ['env'])]) {
      expect(isStaleMcpEntry(own, 'user', 'win32')).toBe(false)
    }
    expect(isStaleMcpEntry(entry('kanbo', ['mcp']), 'user', 'win32')).toBe(true)
  })
})

describe('taking kanbo back out of a configuration file', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'kanbo-config-'))
  })

  afterEach(() => {
    rmSync(directory, { force: true, recursive: true })
  })

  function file(name: string, contents: string): string {
    const path = join(directory, name)
    writeFileSync(path, contents)
    return path
  }

  it('removes the kanbo table and its subtables from config.toml and leaves every other table as it was', () => {
    const before = [
      'model = "o3"',
      '',
      '[mcp_servers.other]',
      'command = "other"',
      'args = ["serve"]',
      '',
      '[mcp_servers."kanbo"]',
      'command = "/opt/kanbo"',
      'args = ["mcp"]',
      '',
      '[mcp_servers.kanbo.env]',
      'KANBO_ACTOR_ID = "codex"',
      '',
      '[profiles.fast]',
      'model = "o4-mini"',
      '',
    ].join('\n')
    const path = file('config.toml', before)

    expect(readCodexMcpCommand(path)).toBe('/opt/kanbo')
    expect(planCodexMcpServerRemoval(path).next).toBe([
      'model = "o3"',
      '',
      '[mcp_servers.other]',
      'command = "other"',
      'args = ["serve"]',
      '',
      '[profiles.fast]',
      'model = "o4-mini"',
      '',
    ].join('\n'))
  })

  it('leaves config.toml alone when it registers no kanbo server, and appends to it otherwise', () => {
    const path = file('config.toml', '[mcp_servers.kanbo_other]\ncommand = "x"\n')

    expect(planCodexMcpServerRemoval(path).next).toBeNull()
    expect(readCodexMcpCommand(path)).toBeUndefined()
    expect(planCodexMcpServer(path).next)
      .toBe('[mcp_servers.kanbo_other]\ncommand = "x"\n\n[mcp_servers.kanbo]\ncommand = "kanbo"\nargs = ["mcp"]\n')
  })

  it('removes only the kanbo entry from an mcpServers map, keeping the empty map', () => {
    const path = file('mcp.json', JSON.stringify({ theme: 'dark', mcpServers: { kanbo: { command: 'kanbo' }, other: { command: 'x' } } }))

    const without = JSON.parse(planJsonMcpServerRemoval(path).next!) as unknown
    expect(without).toEqual({ theme: 'dark', mcpServers: { other: { command: 'x' } } })

    const onlyKanbo = file('only.json', JSON.stringify({ mcpServers: { kanbo: { command: 'kanbo' } } }))
    expect(JSON.parse(planJsonMcpServerRemoval(onlyKanbo).next!)).toEqual({ mcpServers: {} })
  })

  it('reads the other keys and subtables of an entry, and a type other than stdio', () => {
    const toml = file('config.toml', '[mcp_servers.kanbo]\ncommand = "cmd"\nargs = [\n  "/c",\n  "kanbo",\n]\nstartup_timeout_sec = 20\n\n[mcp_servers.kanbo.env]\nA = "1"\n')
    expect(readCodexMcpEntry(toml)?.otherFields).toEqual(['startup_timeout_sec', 'env'])
    const json = file('mcp.json', JSON.stringify({ mcpServers: { kanbo: { type: 'http', command: 'kanbo', args: ['mcp'], cwd: '/x' } } }))
    expect(readJsonMcpEntry(json)?.otherFields).toEqual(['type', 'cwd'])
  })

  it('rewrites only the command and arguments of its own stale entry, keeping the rest in place', () => {
    const launch = { command: 'C:\\node\\node.exe', args: ['C:\\npm\\node_modules\\kanbo-cli\\dist\\cli.cjs', 'mcp'] }
    const toml = file('config.toml', 'model = "o3"\n\n[mcp_servers.kanbo]\n# mine\ncommand = "kanbo"\nargs = ["mcp"]\n\n[profiles.x]\nmodel = "o4"\n')
    expect(planCodexMcpServer(toml, launch, { replace: true }).next).toBe(
      'model = "o3"\n\n[mcp_servers.kanbo]\ncommand = \'C:\\node\\node.exe\'\nargs = [\'C:\\npm\\node_modules\\kanbo-cli\\dist\\cli.cjs\', "mcp"]\n# mine\n\n[profiles.x]\nmodel = "o4"\n',
    )
    const json = file('mcp.json', JSON.stringify({ mcpServers: { kanbo: { command: 'kanbo', args: ['mcp'] } } }))
    expect(JSON.parse(planJsonMcpServer(json, launch, { replace: true }).next!)).toEqual({ mcpServers: { kanbo: { type: 'stdio', ...launch } } })
  })

  it('takes the instruction block out and joins what was around it', () => {
    const path = file('CLAUDE.md', '# Mine\n\nbefore\n')
    const withBlock = planInstructionBlock(path, '<!-- KANBO_START -->\nx\n<!-- KANBO_END -->').next!
    writeFileSync(path, `${withBlock}\nafter\n`)

    expect(planInstructionBlockRemoval(path).next).toBe('# Mine\n\nbefore\n\nafter\n')
  })
})

/**
 * `claude mcp …` started the way every other program is: on Windows the fake
 * is a `.cmd` shim, which Node alone refuses to start.
 */
describe('running claude mcp', () => {
  let bin: string

  beforeEach(() => {
    bin = mkdtempSync(join(tmpdir(), 'kanbo-claude-bin-'))
    vi.stubEnv('PATH', [bin, dirname(process.execPath)].join(delimiter))
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(bin, { force: true, recursive: true })
  })

  it('runs it with its arguments as given, spaces and quotes included', () => {
    const calls = join(bin, 'calls')
    writeRecordingBin(bin, 'claude', calls)

    expect(runClaudeMcp(['claude', 'mcp', 'add', 'a "quoted" name', '--', 'kanbo', 'mcp']))
      .toEqual({ state: 'ran', command: 'claude mcp add a "quoted" name -- kanbo mcp' })
    expect(readFileSync(calls, 'utf8')).toBe('mcp add a "quoted" name -- kanbo mcp\n')
  })

  it('hands the line to the person with the first thing a failing claude said', () => {
    writeFakeBin(bin, 'claude', 'process.stderr.write("already registered\\n"); process.exit(2)')

    expect(runClaudeMcp(['claude', 'mcp', 'add', 'kanbo'])).toEqual({
      state: 'manual',
      command: 'claude mcp add kanbo',
      reason: 'claude exited 2: already registered',
    })
  })
})

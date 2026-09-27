import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { writeFakeBin, writeRecordingBin } from '../../testing/fake-bin'

import { planInstructionBlock, planInstructionBlockRemoval } from './instructions'
import {
  planCodexMcpServer,
  planCodexMcpServerRemoval,
  planJsonMcpServerRemoval,
  readCodexMcpCommand,
  runClaudeMcp,
} from './mcp-config'

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

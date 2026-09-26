import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { planInstructionBlock, planInstructionBlockRemoval } from './instructions'
import {
  planCodexMcpServer,
  planCodexMcpServerRemoval,
  planJsonMcpServerRemoval,
  readCodexMcpCommand,
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

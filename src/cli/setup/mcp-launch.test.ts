import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  claudeUserAddArgv,
  displayCommand,
  planCodexMcpServer,
  planJsonMcpServer,
  readCodexMcpEntry,
  readJsonMcpEntry,
} from './mcp-config'
import { mcpLaunchSpec, WINDOWS_PROJECT_MCP_WARNING } from './mcp-launch'

const NODE = 'C:\\Program Files\\nodejs\\node.exe'
const SCRIPT = 'C:\\Users\\Ann\\AppData\\Roaming\\npm\\node_modules\\kanbo-cli\\dist\\cli.cjs'

describe('mcpLaunchSpec', () => {
  it('is the portable kanbo mcp everywhere but Windows, in either scope', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      for (const scope of ['project', 'user'] as const) {
        expect(mcpLaunchSpec({ platform, scope, execPath: NODE, script: SCRIPT })).toEqual({ command: 'kanbo', args: ['mcp'] })
      }
    }
  })

  it('names this Node and this script for a person\'s own registration on Windows', () => {
    expect(mcpLaunchSpec({ platform: 'win32', scope: 'user', execPath: NODE, script: SCRIPT }))
      .toEqual({ command: NODE, args: [SCRIPT, 'mcp'] })
  })

  it('keeps a project file portable on Windows and says why it may not start there', () => {
    expect(mcpLaunchSpec({ platform: 'win32', scope: 'project', execPath: NODE, script: SCRIPT }))
      .toEqual({ command: 'kanbo', args: ['mcp'], warning: WINDOWS_PROJECT_MCP_WARNING })
  })

  it('names the real script, past the link npm made to it', () => {
    const spec = mcpLaunchSpec({ platform: 'win32', scope: 'user' })
    expect(spec.command).toBe(process.execPath)
    expect(spec.args.at(-1)).toBe('mcp')
  })
})

describe('writing the Windows form', () => {
  let directory: string
  const windows = mcpLaunchSpec({ platform: 'win32', scope: 'user', execPath: NODE, script: SCRIPT })

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'kanbo-launch-'))
  })

  afterEach(() => {
    rmSync(directory, { force: true, recursive: true })
  })

  it('writes Windows paths into config.toml as literal strings, and reads them back', () => {
    const path = join(directory, 'config.toml')
    const next = planCodexMcpServer(path, windows).next!
    expect(next).toBe(`[mcp_servers.kanbo]\ncommand = '${NODE}'\nargs = ['${SCRIPT}', "mcp"]\ndefault_tools_approval_mode = "approve"\n`)
    writeFileSync(path, next)
    expect(readCodexMcpEntry(path)).toEqual({ command: NODE, args: [SCRIPT, 'mcp'], otherFields: [] })
  })

  it('reads escaped basic strings in config.toml as the path they spell', () => {
    const path = join(directory, 'config.toml')
    writeFileSync(path, `[mcp_servers.kanbo]\ncommand = ${JSON.stringify(NODE)}\nargs = [${JSON.stringify(SCRIPT)}, 'mcp']\n`)
    expect(readCodexMcpEntry(path)).toEqual({ command: NODE, args: [SCRIPT, 'mcp'], otherFields: [] })
  })

  it('writes the Node and the script into a JSON registration', () => {
    const path = join(directory, 'mcp.json')
    writeFileSync(path, planJsonMcpServer(path, windows).next!)
    expect(JSON.parse(readFileSync(path, 'utf8')).mcpServers.kanbo).toEqual({ type: 'stdio', command: NODE, args: [SCRIPT, 'mcp'] })
    expect(readJsonMcpEntry(path)).toEqual({ command: NODE, args: [SCRIPT, 'mcp'], otherFields: [] })
  })

  it('hands the same form to claude mcp add', () => {
    expect(claudeUserAddArgv(windows)).toEqual(['claude', 'mcp', 'add', '--scope', 'user', 'kanbo', '--', NODE, SCRIPT, 'mcp'])
    expect(displayCommand(claudeUserAddArgv(windows))).toBe(`claude mcp add --scope user kanbo -- "${NODE}" ${SCRIPT} mcp`)
  })
})

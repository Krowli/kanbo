import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { registerInitCommand } from '../commands/init'
import { collectDoctorFindings } from '../doctor'
import { INSTRUCTION_BLOCK } from './instructions'
import { planJsonMcpServer, readJsonMcpCommand } from './mcp-config'
import { formatText, parseText } from './text-file'

const BOM = '﻿'

/** A line ending that is a bare `\n`, not the end of a `\r\n`. */
const LONE_LF = /(?<!\r)\n/

describe('text files in the shape they came in', () => {
  it('reads CRLF and a byte order mark, and writes both back', () => {
    const file = parseText(`${BOM}# Notes\r\n\r\nmine\r\n`)

    expect(file).toEqual({ text: '# Notes\n\nmine\n', eol: '\r\n', bom: true })
    expect(formatText(`${file.text}more\n`, file)).toBe(`${BOM}# Notes\r\n\r\nmine\r\nmore\r\n`)
  })

  it('takes the ending most lines use', () => {
    expect(parseText('a\r\nb\r\nc\n').eol).toBe('\r\n')
    expect(parseText('a\nb\nc\r\n').eol).toBe('\n')
  })
})

describe('kanbo init and doctor on a Windows-edited project', () => {
  let root: string
  let projectDir: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kanbo-text-'))
    projectDir = join(root, 'project')
    const home = join(root, 'home')
    mkdirSync(projectDir)
    mkdirSync(home)
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    vi.stubEnv('CODEX_HOME', join(root, 'codex-home'))
    vi.stubEnv('PATH', join(root, 'bin'))
    for (const name of ['KANBO_DB_PATH', 'KANBO_WORKSPACE_ID', 'KANBO_DATABASE_URL', 'KANBO_ACTOR_KIND']) {
      vi.stubEnv(name, undefined)
    }
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    rmSync(root, { force: true, recursive: true })
  })

  async function init(): Promise<void> {
    const program = new Command().exitOverride()
    registerInitCommand(program)
    await program.parseAsync(['init', '--file', '--instructions', 'claude', '--mcp', 'claude', '--yes'], { from: 'user' })
  }

  it('keeps a CRLF CLAUDE.md pure CRLF, and the doctor calls its block current', async () => {
    const path = join(projectDir, 'CLAUDE.md')
    writeFileSync(path, '# Project notes\r\n\r\nKeep it tidy.\r\n')

    await init()

    const after = readFileSync(path, 'utf8')
    expect(after).not.toMatch(LONE_LF)
    expect(after).toBe(`# Project notes\r\n\r\nKeep it tidy.\r\n\r\n${INSTRUCTION_BLOCK.replaceAll('\n', '\r\n')}\r\n`)

    const findings = await collectDoctorFindings({ cwd: projectDir, self: null, handshakeTimeoutMs: 1_000 })
    expect(findings.find(finding => finding.detail.startsWith(path))).toMatchObject({ check: 'instructions', status: 'ok' })

    // A second run finds the block current too, and leaves the file alone.
    await init()
    expect(readFileSync(path, 'utf8')).toBe(after)
  })

  it('merges into a .mcp.json with a byte order mark, keeping the mark and the line endings', () => {
    const path = join(projectDir, '.mcp.json')
    writeFileSync(path, `${BOM}{\r\n  "mcpServers": {\r\n    "other": { "command": "other" }\r\n  }\r\n}\r\n`)

    const next = planJsonMcpServer(path).next!
    expect(next.startsWith(BOM)).toBe(true)
    expect(next).not.toMatch(LONE_LF)
    expect(JSON.parse(next.slice(BOM.length))).toEqual({
      mcpServers: { other: { command: 'other' }, kanbo: { type: 'stdio', command: 'kanbo', args: ['mcp'] } },
    })

    writeFileSync(path, next)
    expect(readJsonMcpCommand(path)).toBe('kanbo')
    expect(planJsonMcpServer(path).next).toBeNull()
  })
})

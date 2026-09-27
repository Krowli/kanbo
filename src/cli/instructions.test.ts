import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { KANBO_MCP_INSTRUCTIONS } from '../mcp/instructions'
import type { InstructionsCommandDependencies } from './commands/instructions'
import { NO_BOARD_FOR_INSTRUCTIONS_MESSAGE, registerInstructionsCommand } from './commands/instructions'
import { registerInitCommand } from './commands/init'
import type { ClipboardRunner } from './setup/clipboard'
import { AGENT_GUIDE_TEXT, classifyBlock, COMMAND_SHEET, GLOBAL_BODY, GLOBAL_INSTRUCTION_BLOCK, INSTRUCTION_BLOCK, PROJECT_BODY } from './setup/instructions'
import { ORCHESTRATOR_GUIDE } from './setup/orchestrator-guide'

/** One call a clipboard program got. */
interface ClipboardCall {
  command: string
  args: readonly string[]
  input: Uint8Array
}

describe('kanbo instructions', () => {
  let projectDir: string
  let stdout: string[]
  let stderr: string[]
  let stderrIsTty: boolean | undefined

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'kanbo-instructions-'))
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir)
    for (const name of ['KANBO_DB_PATH', 'KANBO_WORKSPACE_ID', 'KANBO_DATABASE_URL', 'KANBO_ACTOR_KIND', 'CI', 'TERM']) {
      vi.stubEnv(name, undefined)
    }
    stdout = []
    stderr = []
    stderrIsTty = process.stderr.isTTY
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      stdout.push(String(line))
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(String(chunk))
      return true
    })
  })

  afterEach(() => {
    process.stderr.isTTY = stderrIsTty as true
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    rmSync(projectDir, { force: true, recursive: true })
  })

  async function kanbo(argv: string[], dependencies: InstructionsCommandDependencies = {}): Promise<void> {
    const program = new Command().exitOverride()
    registerInstructionsCommand(program, dependencies)
    registerInitCommand(program)
    await program.parseAsync(argv, { from: 'user' })
  }

  it.each([
    [[], AGENT_GUIDE_TEXT],
    [['agent'], AGENT_GUIDE_TEXT],
    [['short'], PROJECT_BODY],
    [['global'], GLOBAL_BODY],
    [['orchestrator'], ORCHESTRATOR_GUIDE],
    [['mcp'], KANBO_MCP_INSTRUCTIONS],
  ])('prints %j as its text, and nothing else on stdout', async (kind, text) => {
    process.stderr.isTTY = true as const
    await kanbo(['instructions', ...kind])

    expect(stdout).toEqual([text])
  })

  it('wraps the pointer in the same markers kanbo writes into a file', async () => {
    await kanbo(['instructions', 'short', '--markers'])
    await kanbo(['instructions', 'global', '--markers'])

    expect(stdout).toEqual([INSTRUCTION_BLOCK, GLOBAL_INSTRUCTION_BLOCK])
  })

  it('marks any other text with its kind, so kanbo connect leaves that block alone', async () => {
    await kanbo(['instructions', 'orchestrator', '--markers'])

    expect(stdout[0]).toMatch(/^<!-- KANBO_START v2 k=orchestrator h=[0-9a-f]{8} -->\n/)
    expect(classifyBlock(stdout[0]!, INSTRUCTION_BLOCK)).toBe('chosen')
  })

  it('says what to do with the text on stderr in a terminal, and nothing when stderr is piped', async () => {
    process.stderr.isTTY = true as const
    await kanbo(['instructions'])
    expect(stderr.join('')).toContain('Paste this into CLAUDE.md or AGENTS.md')
    expect(stderr.join('')).toContain('Other versions: short | global | orchestrator | mcp | board')

    stderr.length = 0
    process.stderr.isTTY = undefined as unknown as true
    await kanbo(['instructions'])
    expect(stderr).toEqual([])
  })

  it('prints this board\'s rules and the commands for board', async () => {
    await kanbo(['init', '--yes'])
    stdout.length = 0

    await kanbo(['instructions', 'board'])

    expect(stdout).toHaveLength(1)
    expect(stdout[0]).toContain('To Do')
    expect(stdout[0]).toContain(COMMAND_SHEET)
  })

  it('says there is no board, and which versions need none, for board in a folder without one', async () => {
    await expect(kanbo(['instructions', 'board'])).rejects.toThrowError(
      expect.objectContaining({ exitCode: 2, message: NO_BOARD_FOR_INSTRUCTIONS_MESSAGE }),
    )
  })

  it('refuses a version that does not exist', async () => {
    await expect(kanbo(['instructions', 'long'])).rejects.toThrowError(expect.objectContaining({ exitCode: 1 }))
  })

  describe('--copy', () => {
    function recordingRunner(result: boolean): { run: ClipboardRunner, calls: ClipboardCall[] } {
      const calls: ClipboardCall[] = []
      return {
        calls,
        run: async (command, args, input) => {
          calls.push({ command, args, input })
          return result
        },
      }
    }

    it('feeds clip.exe UTF-16LE after a byte-order mark on Windows', async () => {
      const { run, calls } = recordingRunner(true)

      await kanbo(['instructions', '--copy'], { clipboard: { platform: 'win32', env: {}, run } })

      expect(calls.map(call => call.command)).toEqual(['clip.exe'])
      const bytes = Buffer.from(calls[0]!.input)
      expect([...bytes.subarray(0, 2)]).toEqual([0xFF, 0xFE])
      expect(bytes.subarray(2).toString('utf16le')).toBe(AGENT_GUIDE_TEXT)
      expect(stderr.join('')).toContain('Copied to the clipboard.')
    })

    it('feeds pbcopy plain UTF-8 on macOS, and keeps stdout to the text', async () => {
      const { run, calls } = recordingRunner(true)

      await kanbo(['instructions', 'short', '--copy'], { clipboard: { platform: 'darwin', env: {}, run } })

      expect(calls.map(call => call.command)).toEqual(['pbcopy'])
      expect(Buffer.from(calls[0]!.input).toString('utf8')).toBe(PROJECT_BODY)
      expect(stdout).toEqual([PROJECT_BODY])
    })

    it('says it could not reach a clipboard when nothing takes the text', async () => {
      const { run, calls } = recordingRunner(false)

      await kanbo(['instructions', '--copy'], { clipboard: { platform: 'linux', env: { DISPLAY: ':0' }, readFile: () => null, run } })

      expect(calls.map(call => call.command)).toEqual(['xclip', 'xsel'])
      expect(stderr.join('')).toContain('Couldn\'t reach a clipboard — select the text above.')
      expect(stdout).toEqual([AGENT_GUIDE_TEXT])
    })
  })
})

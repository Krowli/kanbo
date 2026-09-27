import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PromptDriver } from '../testing/prompt-driver'
import { createPromptDriver } from '../testing/prompt-driver'
import { registerInitCommand } from './commands/init'
import { INSTRUCTION_BLOCK } from './setup/instructions'
import { CancelledError, setUiForTests } from './ui/ui'

/**
 * `kanbo init` answered by a person at a terminal — the prompt driver's
 * streams, keys pressed by the test — on a board file of the project's own.
 */
describe('kanbo init, asked in a terminal', () => {
  let projectDir: string
  let driver: PromptDriver

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'kanbo-init-prompts-'))
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const name of ['KANBO_DB_PATH', 'KANBO_WORKSPACE_ID', 'KANBO_DATABASE_URL', 'KANBO_ACTOR_KIND', 'CI', 'TERM']) {
      vi.stubEnv(name, undefined)
    }
    driver = createPromptDriver()
    setUiForTests(driver.ui)
  })

  afterEach(() => {
    setUiForTests(null)
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    rmSync(projectDir, { force: true, recursive: true })
  })

  function init(): Promise<unknown> {
    const program = new Command().exitOverride()
    registerInitCommand(program)
    return program.parseAsync(['init', '--file'], { from: 'user' })
  }

  it('writes the block into AGENTS.md when that is what the person picks', async () => {
    const running = init()

    await driver.waitFor('Add this block to the project\'s agent instructions?')
    driver.press('down', 'enter')
    await driver.waitFor('Register the board\'s MCP server with which tools?')
    driver.press('enter')
    await running

    expect(readFileSync(join(projectDir, 'AGENTS.md'), 'utf8')).toBe(`${INSTRUCTION_BLOCK}\n`)
    expect(existsSync(join(projectDir, 'CLAUDE.md'))).toBe(false)
    expect(existsSync(join(projectDir, '.mcp.json'))).toBe(false)
  })

  it('stops at Ctrl-C and writes no agent file', async () => {
    const running = init()

    await driver.waitFor('Add this block to the project\'s agent instructions?')
    driver.press('ctrl-c')

    await expect(running).rejects.toBeInstanceOf(CancelledError)
    for (const name of ['CLAUDE.md', 'AGENTS.md', '.mcp.json', '.codex', '.cursor']) {
      expect(existsSync(join(projectDir, name)), name).toBe(false)
    }
  })

  // T11: init writes the binding before it asks anything; this holds once it asks first.
  it.fails('stops at Ctrl-C before writing the binding', async () => {
    const running = init()

    await driver.waitFor('Add this block to the project\'s agent instructions?')
    driver.press('ctrl-c')

    await expect(running).rejects.toBeInstanceOf(CancelledError)
    expect(existsSync(join(projectDir, '.kanbo', 'binding.json'))).toBe(false)
  })
})

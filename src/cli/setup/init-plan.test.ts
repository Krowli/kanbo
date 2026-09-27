import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PromptDriver, PromptKey } from '../../testing/prompt-driver'
import { createPromptDriver } from '../../testing/prompt-driver'
import { readBinding } from '../binding'
import { registerInitCommand } from '../commands/init'
import { registerPrimeCommand } from '../commands/prime'
import { CancelledError, setUiForTests } from '../ui/ui'
import { INSTRUCTION_BLOCK } from './instructions'

/** Every file under the folder, by path, with its bytes — what "left exactly as it was" is checked against. */
function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {}
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry)
      if (statSync(path).isDirectory()) {
        files[`${relative(root, path)}/`] = ''
        walk(path)
      }
      else {
        files[relative(root, path)] = readFileSync(path).toString('base64')
      }
    }
  }
  walk(root)
  return files
}

/**
 * `kanbo init` as plan → preview → confirm → apply, on a machine where
 * nothing names a board: no flags, no `KANBO_*` environment, no binding.
 */
describe('kanbo init with nothing naming a board', () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'kanbo-init-plan-'))
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir)
    for (const name of ['KANBO_DB_PATH', 'KANBO_WORKSPACE_ID', 'KANBO_DATABASE_URL', 'KANBO_ACTOR_KIND', 'CI', 'TERM']) {
      vi.stubEnv(name, undefined)
    }
  })

  afterEach(() => {
    setUiForTests(null)
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    rmSync(projectDir, { force: true, recursive: true })
  })

  async function kanbo(...argv: string[]): Promise<string> {
    const printed: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      printed.push(String(line))
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const program = new Command().exitOverride()
    registerInitCommand(program)
    registerPrimeCommand(program)
    await program.parseAsync(argv, { from: 'user' })
    return printed.join('\n')
  }

  it('creates a board file of the project\'s own with plain kanbo init --yes', async () => {
    await kanbo('init', '--yes')

    expect(existsSync(join(projectDir, '.kanbo', 'board.db'))).toBe(true)
    expect(readBinding(join(projectDir, '.kanbo', 'binding.json'))?.dbPath).toBe(join('.kanbo', 'board.db'))
  })

  it('seeds the standard columns, so kanbo prime right after lists them', async () => {
    await kanbo('init', '--yes')

    const prime = await kanbo('prime')

    expect(prime).toContain('To Do')
    expect(prime).not.toContain('this board has no columns yet')
  })

  describe('asked in a terminal', () => {
    let driver: PromptDriver

    beforeEach(() => {
      driver = createPromptDriver()
      setUiForTests(driver.ui)
    })

    /** Answer the questions of a plain `kanbo init` up to `stopAt`, and press `keys` there. */
    async function answerUpTo(stopAt: string, keys: PromptKey[]): Promise<unknown> {
      const running = kanbo('init').catch((error: unknown) => error)
      const questions: [string, PromptKey[]][] = [
        ['Add this block to the project\'s agent instructions?', ['enter']],
        ['Register the board\'s MCP server with which tools?', ['space', 'enter']],
        ['Make these changes?', ['enter']],
      ]
      for (const [question, answer] of questions) {
        await driver.waitFor(question)
        if (question === stopAt) {
          driver.press(...keys)
          return await running
        }
        driver.press(...answer)
      }
      throw new Error(`no question ${stopAt}`)
    }

    for (const question of [
      'Add this block to the project\'s agent instructions?',
      'Register the board\'s MCP server with which tools?',
      'Make these changes?',
    ]) {
      it(`leaves the folder byte for byte as it was on Ctrl-C at "${question}"`, async () => {
        writeFileSync(join(projectDir, 'CLAUDE.md'), '# Mine\n')
        const before = snapshot(projectDir)

        expect(await answerUpTo(question, ['ctrl-c'])).toBeInstanceOf(CancelledError)

        expect(snapshot(projectDir)).toEqual(before)
      })
    }

    it('shows what it will write before asking, and writes nothing on a no', async () => {
      const before = snapshot(projectDir)

      const outcome = await answerUpTo('Make these changes?', ['down', 'enter'])

      expect(outcome).toEqual(expect.objectContaining({ message: 'Nothing was changed.' }))
      expect(snapshot(projectDir)).toEqual(before)
      const preview = vi.mocked(console.log).mock.calls.map(([line]) => String(line)).join('\n')
      expect(preview).toContain(`create  ${join('.kanbo', 'board.db')}`)
      expect(preview).toContain(`write   ${join('.kanbo', 'binding.json')}`)
      expect(preview).toContain('write   CLAUDE.md')
      expect(preview).toContain('write   .mcp.json')
    })

    it('writes everything it showed once the person says yes', async () => {
      await answerUpTo('Make these changes?', ['enter'])

      expect(existsSync(join(projectDir, '.kanbo', 'board.db'))).toBe(true)
      expect(readFileSync(join(projectDir, 'CLAUDE.md'), 'utf8')).toBe(`${INSTRUCTION_BLOCK}\n`)
      expect(existsSync(join(projectDir, '.mcp.json'))).toBe(true)
    })

    it('leaves a bound project byte for byte as it was on Ctrl-C at the question about an edited block', async () => {
      await kanbo('init', '--yes', '--instructions', 'claude')
      const path = join(projectDir, 'CLAUDE.md')
      writeFileSync(path, readFileSync(path, 'utf8').replace('Take work with', 'Pick work with'))
      const before = snapshot(projectDir)

      const running = kanbo('init', '--instructions', 'claude').catch((error: unknown) => error)
      await driver.waitFor('You changed the kanbo section in')
      driver.press('ctrl-c')

      expect(await running).toBeInstanceOf(CancelledError)
      expect(snapshot(projectDir)).toEqual(before)
    })
  })
})

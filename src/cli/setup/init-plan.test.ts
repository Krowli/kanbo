import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'

import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { suggestCardKey } from '../../domain/key-suggestion'
import type { PromptDriver, PromptKey } from '../../testing/prompt-driver'
import { createPromptDriver } from '../../testing/prompt-driver'
import { readBinding } from '../binding'
import { CONNECT_LATER_TIP, registerInitCommand } from '../commands/init'
import { registerPrimeCommand } from '../commands/prime'
import { registerReadyCommand } from '../commands/ready'
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
    registerReadyCommand(program)
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

  it('sets up the board only, with the suggested key, and says how to connect agents later', async () => {
    const printed = await kanbo('init', '--yes')

    expect(readBinding(join(projectDir, '.kanbo', 'binding.json'))?.identifier).toBe(suggestCardKey(basename(projectDir)))
    expect(readdirSync(projectDir)).toEqual(['.kanbo'])
    expect(printed).toContain(CONNECT_LATER_TIP)
  })

  it('starts the board with the columns, key and first card the flags name', async () => {
    const printed = await kanbo('init', '--yes', '--columns', 'simple', '--key', 'abc', '--first-card', 'Check the sensors', '--connect', 'none')

    expect(printed).toContain('Columns: To Do, In Progress, Done')
    expect(printed).toContain('First card: ABC-001 Check the sensors')
    const ready = await kanbo('ready', '--json', 'id,title')
    expect(JSON.parse(ready)).toEqual([{ id: 'ABC-001', title: 'Check the sensors' }])
  })

  it('in an agent\'s shell without --yes sets up the board but changes no agent file, and says how to', async () => {
    vi.stubEnv('CLAUDECODE', '1')
    const said: string[] = []
    const printed = await kanbo('init', '--connect', 'claude')
    vi.mocked(console.error).mock.calls.forEach(call => said.push(String(call[0])))

    expect(existsSync(join(projectDir, '.kanbo', 'board.db'))).toBe(true)
    expect(readdirSync(projectDir)).toEqual(['.kanbo'])
    expect(said.join('\n')).toContain('Not changing agent files without a yes: run kanbo connect claude --yes')
    expect(printed).toContain(CONNECT_LATER_TIP)

    await kanbo('init', '--connect', 'claude', '--yes')
    expect(readFileSync(join(projectDir, 'CLAUDE.md'), 'utf8')).toContain('KANBO_START')
  })

  it('takes a list of columns, and puts the ones it does not know as the person\'s own', async () => {
    const printed = await kanbo('init', '--yes', '--columns', 'To Do, Doing, QA, Done')

    expect(printed).toContain('Columns: To Do, Doing, QA, Done')
  })

  it('refuses a column list without To Do, and a card key that cannot be one, before writing anything', async () => {
    await expect(kanbo('init', '--yes', '--columns', 'Doing, Done')).rejects.toThrow('--columns needs To Do')
    await expect(kanbo('init', '--yes', '--key', '1AB')).rejects.toThrow('can\'t be a card key')
    await expect(kanbo('init', '--yes', '--connect', 'claude', '--instructions', 'claude')).rejects.toThrow('not both')
    expect(readdirSync(projectDir)).toEqual([])
  })

  describe('asked in a terminal', () => {
    let driver: PromptDriver

    beforeEach(() => {
      driver = createPromptDriver()
      setUiForTests(driver.ui)
    })

    /**
     * Answer the wizard of `kanbo init --connect claude` up to `stopAt`, and
     * press `keys` there. `--connect` answers the agent questions, so the
     * agents this machine happens to have do not change what is asked.
     */
    async function answerUpTo(stopAt: string, keys: PromptKey[]): Promise<unknown> {
      const running = kanbo('init', '--connect', 'claude').catch((error: unknown) => error)
      const questions: [string, PromptKey[]][] = [
        ['Where should the board live?', ['enter']],
        ['Card numbers start with', ['enter']],
        ['Which columns should the board start with?', ['enter']],
        ['Keep all of them?', ['enter']],
        ['Add a first card?', ['enter']],
        ['Write these changes?', ['enter']],
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
      'Where should the board live?',
      'Card numbers start with',
      'Which columns should the board start with?',
      'Keep all of them?',
      'Add a first card?',
      'Write these changes?',
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

      const outcome = await answerUpTo('Write these changes?', ['down', 'enter'])

      expect(outcome).toEqual(expect.objectContaining({ message: 'Nothing was written.' }))
      expect(snapshot(projectDir)).toEqual(before)
      const preview = driver.transcript()
      expect(preview).toContain(`create  ${join('.kanbo', 'board.db')}`)
      expect(preview).toContain(`write   ${join('.kanbo', 'binding.json')}`)
      expect(preview).toContain('write   CLAUDE.md')
    })

    it('writes everything it showed once the person says yes', async () => {
      await answerUpTo('Write these changes?', ['enter'])

      expect(existsSync(join(projectDir, '.kanbo', 'board.db'))).toBe(true)
      expect(readFileSync(join(projectDir, 'CLAUDE.md'), 'utf8')).toBe(`${INSTRUCTION_BLOCK}\n`)
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

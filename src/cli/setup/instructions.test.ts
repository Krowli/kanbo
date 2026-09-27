import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PromptDriver } from '../../testing/prompt-driver'
import { createPromptDriver } from '../../testing/prompt-driver'
import { registerInitCommand } from '../commands/init'
import { registerPrimeCommand } from '../commands/prime'
import { setUiForTests } from '../ui/ui'
import { applyFileChange } from './file-change'
import {
  AGENT_GUIDE_TEXT,
  classifyBlock,
  GLOBAL_INSTRUCTION_BLOCK,
  INSTRUCTION_BLOCK,
  planInstructionBlock,
  planInstructionBlockAsking,
  planInstructionBlockRemoval,
  wrapInstructionBlock,
} from './instructions'

/** A project's `CLAUDE.md` exactly as `kanbo init --instructions claude` 0.2.1 left it. */
const CLAUDE_MD_0_2_1 = readFileSync(join(import.meta.dirname, 'fixtures', 'claude-md-0.2.1.md'), 'utf8')

/** The same file after the person changed a word inside the current block. */
const EDITED_BLOCK = INSTRUCTION_BLOCK.replace('Take work with', 'Pick work with')

describe('the kanbo instruction block', () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'kanbo-instructions-'))
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

  /** Run kanbo commands in the project, and hand back what they printed on stdout and stderr. */
  async function kanbo(...argv: string[]): Promise<{ out: string, err: string }> {
    const out: string[] = []
    const err: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      out.push(String(line))
    })
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      err.push(String(line))
    })
    const program = new Command().exitOverride()
    registerInitCommand(program)
    registerPrimeCommand(program)
    await program.parseAsync(argv, { from: 'user' })
    return { out: out.join('\n'), err: err.join('\n') }
  }

  function claudeMd(): string {
    return readFileSync(join(projectDir, 'CLAUDE.md'), 'utf8')
  }

  it('is a short pointer with a version and hash on its marker', () => {
    expect(INSTRUCTION_BLOCK).toMatch(/^<!-- KANBO_START v2 h=[0-9a-f]{8} -->\n/)
    expect(INSTRUCTION_BLOCK.split('\n').length).toBeLessThanOrEqual(7)
    expect(INSTRUCTION_BLOCK).toContain('run `kanbo prime`')
    expect(GLOBAL_INSTRUCTION_BLOCK).toContain('In a project with a `.kanbo/` folder')
  })

  it('reads the 0.2.1 block as legacy, and the whole old guide is kept word for word', () => {
    expect(classifyBlock(CLAUDE_MD_0_2_1, INSTRUCTION_BLOCK)).toBe('legacy')
    const body = CLAUDE_MD_0_2_1.split('<!-- KANBO_START -->\n')[1]!.split('\n<!-- KANBO_END -->')[0]
    expect(AGENT_GUIDE_TEXT).toBe(body)
  })

  it('replaces the 0.2.1 block under --yes and keeps the rest of the file', async () => {
    writeFileSync(join(projectDir, 'CLAUDE.md'), CLAUDE_MD_0_2_1)

    await kanbo('init', '--file', '--instructions', 'claude', '--yes')

    expect(claudeMd()).toBe(`# Project notes\n\n${INSTRUCTION_BLOCK}\n`)
  })

  it('leaves a block the person edited alone under --yes, and says so', async () => {
    writeFileSync(join(projectDir, 'CLAUDE.md'), `# Mine\n\n${EDITED_BLOCK}\n`)
    expect(classifyBlock(claudeMd(), INSTRUCTION_BLOCK)).toBe('edited')

    const { err } = await kanbo('init', '--file', '--instructions', 'claude', '--yes')

    expect(claudeMd()).toBe(`# Mine\n\n${EDITED_BLOCK}\n`)
    expect(err).toContain('you changed the kanbo section')
  })

  describe('an edited block, asked about at a terminal', () => {
    let driver: PromptDriver

    beforeEach(() => {
      driver = createPromptDriver()
      setUiForTests(driver.ui)
    })

    async function plan(keys: Parameters<PromptDriver['press']>): Promise<string | null> {
      const path = join(projectDir, 'CLAUDE.md')
      writeFileSync(path, `# Mine\n\n${EDITED_BLOCK}\n`)
      const planning = planInstructionBlockAsking(path, INSTRUCTION_BLOCK, {})
      await driver.waitFor('You changed the kanbo section in')
      driver.press(...keys)
      return (await planning).change.next
    }

    it('keeps it when the person just presses Enter', async () => {
      expect(await plan(['enter'])).toBeNull()
    })

    it('replaces it when the person says yes', async () => {
      expect(await plan(['down', 'enter'])).toBe(`# Mine\n\n${INSTRUCTION_BLOCK}\n`)
    })
  })

  it('round-trips: the block it writes reads as current, in LF and in CRLF, and a second write changes nothing', () => {
    const path = join(projectDir, 'CLAUDE.md')
    applyFileChange(planInstructionBlock(path, INSTRUCTION_BLOCK))

    expect(classifyBlock(claudeMd(), INSTRUCTION_BLOCK)).toBe('current')
    expect(classifyBlock(claudeMd().replaceAll('\n', '\r\n'), INSTRUCTION_BLOCK)).toBe('current')
    expect(planInstructionBlock(path, INSTRUCTION_BLOCK).next).toBeNull()
  })

  it('reads an untouched block of an older version, or of the other scope, as outdated', () => {
    expect(classifyBlock(wrapInstructionBlock('## Kanbo board\n\nOld words.', 1), INSTRUCTION_BLOCK)).toBe('outdated')
    expect(classifyBlock(GLOBAL_INSTRUCTION_BLOCK, INSTRUCTION_BLOCK)).toBe('outdated')
  })

  it('takes out every kind of block: current, outdated, legacy and edited', () => {
    const path = join(projectDir, 'CLAUDE.md')
    for (const block of [INSTRUCTION_BLOCK, wrapInstructionBlock('Old words.', 1), CLAUDE_MD_0_2_1.slice('# Project notes\n\n'.length), EDITED_BLOCK]) {
      writeFileSync(path, `# Mine\n\n${block}\n\nMore of mine.\n`)
      expect(planInstructionBlockRemoval(path).next).toBe('# Mine\n\nMore of mine.\n')
    }
  })

  it('kanbo prime on the command line ends with the commands', async () => {
    await kanbo('init', '--file', '--instructions', 'none', '--yes')

    const { out } = await kanbo('prime')

    expect(out).toContain('How this board works:')
    expect(out).toContain('Commands:')
    expect(out).toContain('`kanbo card move <id> <column>`')
  })
})

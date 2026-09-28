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
  inspectBlock,
  INSTRUCTION_BLOCK,
  INSTRUCTION_END,
  planInstructionBlock,
  planInstructionBlockAsking,
  planInstructionBlockRemoval,
  planInstructionBlockRemovalAsking,
  PROJECT_BODY,
  wrapInstructionBlock,
} from './instructions'
import { LEGACY_BLOCK_BODIES } from './legacy-blocks'

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

  it('reads the 0.2.1 block as legacy, by its body kept word for word', () => {
    expect(classifyBlock(CLAUDE_MD_0_2_1, INSTRUCTION_BLOCK)).toBe('legacy')
    expect(classifyBlock(CLAUDE_MD_0_2_1.replaceAll('\n', '\r\n'), INSTRUCTION_BLOCK)).toBe('legacy')
    const body = CLAUDE_MD_0_2_1.split('<!-- KANBO_START -->\n')[1]!.split('\n<!-- KANBO_END -->')[0]
    expect(LEGACY_BLOCK_BODIES).toContain(body)
    // The guide itself has moved on since (0.3.0: kanbo fills in the session).
    expect(AGENT_GUIDE_TEXT).not.toBe(body)
  })

  it('reads a bare-marker block whose body no 0.1–0.2 release wrote as edited, and keeps it under --yes', async () => {
    const changed = CLAUDE_MD_0_2_1.replace('Take a card from', 'Always take a card from')
    expect(classifyBlock(changed, INSTRUCTION_BLOCK)).toBe('edited')
    for (const body of LEGACY_BLOCK_BODIES) {
      expect(classifyBlock(`<!-- KANBO_START -->\n${body}\n<!-- KANBO_END -->`, INSTRUCTION_BLOCK)).toBe('legacy')
    }
    writeFileSync(join(projectDir, 'CLAUDE.md'), changed)

    const { err } = await kanbo('init', '--file', '--instructions', 'claude', '--yes')

    expect(claudeMd()).toBe(changed)
    expect(err).toContain('you changed the kanbo section')
  })

  it('reads a block a newer kanbo wrote as newer, a chosen text as chosen, and markers that do not pair up as damaged', () => {
    expect(inspectBlock(wrapInstructionBlock('## Kanbo board\n\nNewer words.', 3), INSTRUCTION_BLOCK))
      .toEqual({ state: 'newer', version: 3, kind: null })
    expect(inspectBlock(wrapInstructionBlock('Any text.', 2, 'orchestrator'), INSTRUCTION_BLOCK))
      .toEqual({ state: 'chosen', version: 2, kind: 'orchestrator' })
    expect(classifyBlock(wrapInstructionBlock(PROJECT_BODY, 2, 'short'), INSTRUCTION_BLOCK)).toBe('outdated')
    expect(inspectBlock(`# Mine\n${INSTRUCTION_BLOCK.replace(INSTRUCTION_END, '')}`, INSTRUCTION_BLOCK))
      .toMatchObject({ state: 'damaged', damage: 'a kanbo start marker without an end' })
    expect(inspectBlock(`${INSTRUCTION_END}\n${INSTRUCTION_BLOCK}`, INSTRUCTION_BLOCK))
      .toMatchObject({ state: 'damaged', damage: 'a kanbo end marker without a start' })
    expect(inspectBlock(INSTRUCTION_BLOCK.replace('## Kanbo board', INSTRUCTION_BLOCK), INSTRUCTION_BLOCK))
      .toMatchObject({ state: 'damaged', damage: 'a kanbo start marker inside another kanbo section' })
  })

  it('writes nothing into and removes nothing from a file with a start marker and no end (the review\'s probe)', () => {
    const path = join(projectDir, 'CLAUDE.md')
    const probe = '# Mine\r\n\r\n<!-- KANBO_START -->\r\nMy own notes, which go on.\r\n\r\n## More of mine\r\n'
    writeFileSync(path, probe)

    expect(planInstructionBlock(path, INSTRUCTION_BLOCK).next).toBeNull()
    expect(planInstructionBlockRemoval(path).next).toBeNull()
    expect(readFileSync(path, 'utf8')).toBe(probe)
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

  // Was: every kind of block, the edited one included, came out without a word. A block the person
  // changed is theirs (the review's rule: kanbo removes only what it wrote, in the shape it wrote it),
  // so it now goes only on --yes or a yes at a terminal, and is kept — with a note — otherwise.
  it('takes out kanbo\'s own blocks — current, outdated, legacy — and an edited, chosen or newer one only on --yes', async () => {
    const path = join(projectDir, 'CLAUDE.md')
    const without = '# Mine\n\nMore of mine.\n'
    for (const block of [INSTRUCTION_BLOCK, wrapInstructionBlock('Old words.', 1), CLAUDE_MD_0_2_1.slice('# Project notes\n\n'.length)]) {
      writeFileSync(path, `# Mine\n\n${block}\n\nMore of mine.\n`)
      expect((await planInstructionBlockRemovalAsking(path, {})).change.next).toBe(without)
    }
    for (const block of [EDITED_BLOCK, wrapInstructionBlock('Mine.', 2, 'orchestrator'), wrapInstructionBlock('Newer.', 3)]) {
      writeFileSync(path, `# Mine\n\n${block}\n\nMore of mine.\n`)
      const kept = await planInstructionBlockRemovalAsking(path, { label: 'CLAUDE.md' })
      expect(kept.change.next).toBeNull()
      expect(kept.note).toBe('CLAUDE.md: you changed the kanbo section, so it was kept. Remove it with --yes.')
      expect((await planInstructionBlockRemovalAsking(path, { yes: true })).change.next).toBe(without)
    }
  })

  describe('removing an edited block, asked about at a terminal', () => {
    let driver: PromptDriver

    beforeEach(() => {
      driver = createPromptDriver()
      setUiForTests(driver.ui)
    })

    async function remove(keys: Parameters<PromptDriver['press']>): Promise<string | null> {
      const path = join(projectDir, 'CLAUDE.md')
      writeFileSync(path, `# Mine\n\n${EDITED_BLOCK}\n`)
      const planning = planInstructionBlockRemovalAsking(path, { label: 'CLAUDE.md' })
      await driver.waitFor('You changed the kanbo section in CLAUDE.md. Remove it anyway?')
      driver.press(...keys)
      return (await planning).change.next
    }

    it('keeps it when the person just presses Enter', async () => {
      expect(await remove(['enter'])).toBeNull()
    })

    it('removes it when the person says yes', async () => {
      expect(await remove(['down', 'enter'])).toBe('# Mine\n')
    })
  })

  it('kanbo prime on the command line ends with the commands', async () => {
    await kanbo('init', '--file', '--instructions', 'none', '--yes')

    const { out } = await kanbo('prime')

    expect(out).toContain('How this board works:')
    expect(out).toContain('Commands (a card is named by its id')
    expect(out).toContain('`kanbo card move TST-5 in_progress`')
    // The arguments agents got wrong, written out, so they need no `kanbo capabilities` first.
    expect(out).toContain('--content "')
    expect(out).toContain('--state finished')
    // A card created at the wrong level is moved, not made again.
    expect(out).toContain('`kanbo card update TST-7 --parent TST-5`')
    expect(out).toContain('`--parent none`')
  })
})

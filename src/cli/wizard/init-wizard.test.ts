import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { Command } from 'commander'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PromptDriver } from '../../testing/prompt-driver'
import { createPromptDriver } from '../../testing/prompt-driver'
import { readBinding } from '../binding'
import type { InitOptions } from '../commands/init'
import { AGENT_URL_MISSING_WARNING, normalizeInitOptions, planInit, registerInitCommand } from '../commands/init'
import { registerPrimeCommand } from '../commands/prime'
import type { AgentDetection } from '../setup/agents'
import { AGENT_IDS } from '../setup/agents'
import { INSTRUCTION_BLOCK } from '../setup/instructions'
import { NPX_LAUNCH_WARNING } from '../setup/launch-warning'
import { CancelledError, setUiForTests } from '../ui/ui'
import { runInitWizard } from './init-wizard'

/**
 * The init wizard, answered key by key through the prompt driver, with every
 * screen it draws kept as a golden transcript in `src/cli/__golden__/`.
 *
 * What differs between machines is pinned: which agents are "found" (a list
 * the test sets), the MCP form (the POSIX one; Windows' own forms are covered
 * by the connect and mcp-launch tests), whether kanbo is on PATH, and the
 * prompt library's glyphs. Temporary paths read `<project>` and `<home>`.
 */
const machine = vi.hoisted(() => ({ detected: [] as string[], launchWarning: null as string | null }))

vi.mock('../setup/agents', async (importOriginal) => {
  const original = await importOriginal<typeof import('../setup/agents')>()
  const { homedir } = await import('node:os')
  const { join: joinPath } = await import('node:path')
  return {
    ...original,
    defaultMcpScope: (agent: keyof typeof original.AGENTS) => original.AGENTS[agent].mcpScope,
    detectAgents: (): AgentDetection[] => original.AGENT_IDS.map(agent => ({
      agent,
      detected: machine.detected.includes(agent),
      evidence: machine.detected.includes(agent) ? [joinPath(homedir(), `.${agent}`)] : [],
    })),
  }
})

vi.mock('../setup/mcp-launch', async (importOriginal) => {
  const original = await importOriginal<typeof import('../setup/mcp-launch')>()
  return { ...original, mcpLaunchSpec: (input: Parameters<typeof original.mcpLaunchSpec>[0]) => original.mcpLaunchSpec({ ...input, platform: 'linux' }) }
})

vi.mock('../setup/launch-warning', async (importOriginal) => {
  const original = await importOriginal<typeof import('../setup/launch-warning')>()
  return { ...original, readLaunchWarning: () => machine.launchWarning }
})

/** Every file under the folder, by path, with its bytes. */
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

/** A step of the wizard: the question to wait for, and what the person presses there. */
type Step = [question: string, answer: (driver: PromptDriver) => void]

const enter: Step[1] = driver => driver.press('enter')
const typeLine = (text: string): Step[1] => (driver) => {
  driver.type(text)
  driver.press('enter')
}

describe('kanbo init wizard', () => {
  let root: string
  let home: string
  let projectDir: string
  let driver: PromptDriver

  beforeAll(async () => {
    // The prompt library picks its glyphs once, when it loads; Windows
    // Terminal's mark makes that the Unicode set on every OS.
    vi.stubEnv('WT_SESSION', 'kanbo-golden')
    await import('@clack/prompts')
    vi.unstubAllEnvs()
  })

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'kanbo-wizard-')))
    home = join(root, 'home')
    projectDir = join(root, 'weather-station')
    mkdirSync(home)
    mkdirSync(projectDir)
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const name of ['KANBO_DB_PATH', 'KANBO_WORKSPACE_ID', 'KANBO_DATABASE_URL', 'KANBO_ACTOR_KIND', 'CI', 'TERM', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GEMINI_CLI_HOME']) {
      vi.stubEnv(name, undefined)
    }
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    machine.detected = []
    machine.launchWarning = null
    driver = createPromptDriver()
    setUiForTests(driver.ui)
  })

  afterEach(() => {
    setUiForTests(null)
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    rmSync(root, { force: true, recursive: true })
  })

  function kanbo(...argv: string[]): Promise<unknown> {
    const program = new Command().exitOverride()
    registerInitCommand(program)
    registerPrimeCommand(program)
    return program.parseAsync(argv, { from: 'user' }).then(() => null, (error: unknown) => error)
  }

  /** Run `kanbo init` through these steps; the promise settles with the error it stopped on, or `null`. */
  async function wizard(steps: Step[], ...flags: string[]): Promise<unknown> {
    const running = kanbo('init', ...flags)
    for (const [question, answer] of steps) {
      await driver.waitFor(question)
      answer(driver)
    }
    return await running
  }

  /** The transcript as the golden file keeps it: machine paths replaced, trailing spaces dropped. */
  function transcript(outcome: unknown): string {
    const text = driver.transcript()
      .replaceAll(projectDir, '<project>')
      .replaceAll(home, '<home>')
      .replaceAll(root, '<root>')
      .replaceAll('\\', '/')
      .split('\n')
      .map(line => line.trimEnd())
      .join('\n')
    const ending = outcome === null ? 'exit 0' : `exit ${(outcome as { exitCode?: number }).exitCode ?? '?'}: ${(outcome as Error).message}`
    const files = Object.keys(snapshot(projectDir)).map(path => path.replaceAll('\\', '/')).sort()
    return `${text}\n--- ${ending}\n--- files in <project>:\n${files.join('\n')}\n`
  }

  const golden = (name: string): string => join(__dirname, '..', '__golden__', `init-${name}.txt`)

  /** The questions of a new project's file board with Claude Code found and connected. */
  const standardClaude: Step[] = [
    ['Where should the board live?', enter],
    ['Card numbers start with', enter],
    ['Which columns should the board start with?', enter],
    ['Which coding agents do you use here?', enter],
    ['Connect them now?', enter],
    ['Keep all of them?', enter],
    ['Add a first card?', typeLine('Write the README')],
    ['Write these changes?', enter],
  ]

  it('sets up a file board with the standard columns and connects Claude Code', async () => {
    machine.detected = ['claude']
    machine.launchWarning = NPX_LAUNCH_WARNING

    const outcome = await wizard(standardClaude)

    expect(outcome).toBeNull()
    await expect(transcript(outcome)).toMatchFileSnapshot(golden('standard-claude'))
    expect(readBinding(join(projectDir, '.kanbo', 'binding.json'))).toMatchObject({ workspaceId: 'weather-station', identifier: 'WST' })
    expect(readFileSync(join(projectDir, 'CLAUDE.md'), 'utf8')).toBe(`${INSTRUCTION_BLOCK}\n`)
    expect(existsSync(join(projectDir, '.mcp.json'))).toBe(true)
  })

  it('touches nothing but the board with "Not now"', async () => {
    machine.detected = ['claude', 'codex']

    const outcome = await wizard([
      ['Where should the board live?', enter],
      ['Card numbers start with', typeLine('met')],
      ['Which columns should the board start with?', (d) => d.press('down', 'enter')],
      ['Which coding agents do you use here?', enter],
      ['Connect them now?', d => d.press('down', 'enter')],
      ['Add a first card?', enter],
      ['Write these changes?', enter],
    ])

    expect(outcome).toBeNull()
    await expect(transcript(outcome)).toMatchFileSnapshot(golden('not-now'))
    expect(readBinding(join(projectDir, '.kanbo', 'binding.json'))?.identifier).toBe('MET')
    expect(readdirSync(projectDir)).toEqual(['.kanbo'])
    expect(readdirSync(home)).toEqual([])
  })

  it('prints the instructions and writes no agent file with "I\'ll paste the instructions myself"', async () => {
    machine.detected = ['claude']

    const outcome = await wizard([
      ['Where should the board live?', enter],
      ['Card numbers start with', enter],
      ['Which columns should the board start with?', enter],
      ['Which coding agents do you use here?', enter],
      ['Connect them now?', d => d.press('down', 'down', 'enter')],
      ['Add a first card?', enter],
      ['Write these changes?', enter],
    ])

    expect(outcome).toBeNull()
    await expect(transcript(outcome)).toMatchFileSnapshot(golden('paste-myself'))
    expect(driver.transcript()).toContain(INSTRUCTION_BLOCK.split('\n')[1]!)
    expect(readdirSync(projectDir)).toEqual(['.kanbo'])
  })

  it('builds custom columns: To Do kept, QA picked, one of the person\'s own before Done', async () => {
    const outcome = await wizard([
      ['Where should the board live?', enter],
      ['Card numbers start with', enter],
      ['Which columns should the board start with?', d => d.press('down', 'down', 'down', 'enter')],
      // Untick To Do (it comes back), tick QA.
      ['Pick the columns', d => d.press('down', 'space', 'down', 'down', 'down', 'space', 'enter')],
      ['Any columns of your own?', typeLine('Design, Blocked')],
      ['One line about "Design"', typeLine('Being sketched before anyone builds it')],
      ['Which coding agents do you use here?', enter],
      ['Add a first card?', enter],
      ['Write these changes?', enter],
    ])

    expect(outcome).toBeNull()
    await expect(transcript(outcome)).toMatchFileSnapshot(golden('custom-columns'))
    const prime = vi.mocked(console.log)
    prime.mockClear()
    await kanbo('prime')
    const printed = prime.mock.calls.map(([line]) => String(line)).join('\n')
    const names = ['Backlog', 'To Do', 'In Progress', 'In Review', 'QA', 'Design', 'Blocked', 'Done', 'Canceled']
    const positions = names.map(name => printed.indexOf(`- ${name} (`))
    expect(positions.every(position => position >= 0), printed).toBe(true)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    expect(printed).toContain('Being sketched before anyone builds it')
  })

  it('binds a shared Postgres board, masks the connection string, and runs nothing when the tables are declined', async () => {
    const outcome = await wizard([
      ['Where should the board live?', d => d.press('down', 'enter')],
      ['Connection string for the shared board', typeLine('postgres://u:secret@db/x')],
      ['Workspace id', enter],
      ['Create the board\'s tables in that database now?', d => d.type('n')],
      ['Card numbers start with', enter],
      ['Which coding agents do you use here?', enter],
      ['Write these changes?', enter],
    ])

    expect(outcome).toBeNull()
    await expect(transcript(outcome)).toMatchFileSnapshot(golden('postgres'))
    expect(driver.transcript()).not.toContain('secret')
    expect(driver.transcript()).toContain(AGENT_URL_MISSING_WARNING)
    expect(readBinding(join(projectDir, '.kanbo', 'binding.json'))).toMatchObject({
      workspaceId: 'weather-station',
      identifier: 'WST',
      databaseUrl: 'postgres://u:secret@db/x',
    })
    expect(existsSync(join(projectDir, '.kanbo', 'board.db'))).toBe(false)
  })

  it('asks nothing about the board of a project that has one, and connects its agents', async () => {
    expect(await kanbo('init', '--yes', '--key', 'WEA')).toBeNull()
    machine.detected = ['claude']
    driver = createPromptDriver()
    setUiForTests(driver.ui)

    const outcome = await wizard([
      ['Which coding agents do you use here?', enter],
      ['Connect them now?', enter],
      ['Keep all of them?', enter],
      ['Add a first card?', enter],
      ['Write these changes?', enter],
    ])

    expect(outcome).toBeNull()
    await expect(transcript(outcome)).toMatchFileSnapshot(golden('reconfigure'))
    expect(driver.transcript()).not.toContain('Where should the board live?')
    expect(readBinding(join(projectDir, '.kanbo', 'binding.json'))?.identifier).toBe('WEA')
  })

  it('keeps a kanbo section the person edited unless they say to replace it', async () => {
    expect(await kanbo('init', '--yes', '--connect', 'claude')).toBeNull()
    const claudeMd = join(projectDir, 'CLAUDE.md')
    const edited = readFileSync(claudeMd, 'utf8').replace('kanbo prime', 'kanbo prime first')
    writeFileSync(claudeMd, edited)
    machine.detected = ['claude']
    driver = createPromptDriver()
    setUiForTests(driver.ui)

    const outcome = await wizard([
      ['Which coding agents do you use here?', enter],
      ['Connect them now?', enter],
      ['You changed the kanbo section in', enter],
      ['Add a first card?', enter],
      ['Write these changes?', enter],
    ])

    expect(outcome).toBeNull()
    await expect(transcript(outcome)).toMatchFileSnapshot(golden('edited-block'))
    expect(readFileSync(claudeMd, 'utf8')).toBe(edited)
  })

  it('replaces a kanbo 0.2 section with the current one', async () => {
    const legacy = readFileSync(join(__dirname, '..', 'setup', 'fixtures', 'claude-md-0.2.1.md'), 'utf8')
    writeFileSync(join(projectDir, 'CLAUDE.md'), legacy)
    machine.detected = ['claude']

    const outcome = await wizard(standardClaude)

    expect(outcome).toBeNull()
    await expect(transcript(outcome)).toMatchFileSnapshot(golden('legacy-block'))
    const claudeMd = readFileSync(join(projectDir, 'CLAUDE.md'), 'utf8')
    expect(claudeMd).toContain('# Project notes')
    expect(claudeMd).toContain(INSTRUCTION_BLOCK)
    expect(claudeMd).not.toContain('<!-- KANBO_START -->')
  })

  it('offers the repository root when started in a folder inside one', async () => {
    mkdirSync(join(projectDir, '.git'))
    const inside = join(projectDir, 'packages', 'web')
    mkdirSync(inside, { recursive: true })
    vi.mocked(process.cwd).mockReturnValue(inside)

    const outcome = await wizard([
      ['Where should the board be set up?', enter],
      ['Where should the board live?', enter],
      ['Card numbers start with', enter],
      ['Which columns should the board start with?', enter],
      ['Which coding agents do you use here?', enter],
      ['Add a first card?', enter],
      ['Write these changes?', enter],
    ])

    expect(outcome).toBeNull()
    await expect(transcript(outcome)).toMatchFileSnapshot(golden('repo-root'))
    expect(existsSync(join(projectDir, '.kanbo', 'binding.json'))).toBe(true)
    expect(existsSync(join(inside, '.kanbo'))).toBe(false)
  })

  describe('stopped with Ctrl-C', () => {
    for (const [index, [question]] of standardClaude.entries()) {
      it(`leaves the folder and home byte for byte as they were at "${question}"`, async () => {
        machine.detected = ['claude']
        writeFileSync(join(projectDir, 'CLAUDE.md'), '# Mine\n')
        const before = { project: snapshot(projectDir), home: snapshot(home) }

        const outcome = await wizard([...standardClaude.slice(0, index), [question, d => d.press('ctrl-c')]])

        expect(outcome).toBeInstanceOf(CancelledError)
        expect((outcome as Error).message).toBe('Cancelled — nothing was written.')
        expect((outcome as CancelledError).exitCode).toBe(1)
        expect({ project: snapshot(projectDir), home: snapshot(home) }).toEqual(before)
      })
    }

    it('leaves a bound project as it was at the question about an edited block', async () => {
      expect(await kanbo('init', '--yes', '--connect', 'claude')).toBeNull()
      const claudeMd = join(projectDir, 'CLAUDE.md')
      writeFileSync(claudeMd, readFileSync(claudeMd, 'utf8').replace('kanbo prime', 'kanbo prime first'))
      const before = snapshot(projectDir)
      machine.detected = ['claude']
      driver = createPromptDriver()
      setUiForTests(driver.ui)

      const outcome = await wizard([
        ['Which coding agents do you use here?', enter],
        ['Connect them now?', enter],
        ['You changed the kanbo section in', d => d.press('ctrl-c')],
      ])

      expect(outcome).toBeInstanceOf(CancelledError)
      expect(snapshot(projectDir)).toEqual(before)
    })
  })

  it('writes nothing when the person says no at the end', async () => {
    const before = snapshot(projectDir)

    const outcome = await wizard([
      ['Where should the board live?', enter],
      ['Card numbers start with', enter],
      ['Which columns should the board start with?', enter],
      ['Which coding agents do you use here?', enter],
      ['Add a first card?', enter],
      ['Write these changes?', d => d.type('n')],
    ])

    expect(outcome).toEqual(expect.objectContaining({ message: 'Nothing was written.', exitCode: 1 }))
    expect(snapshot(projectDir)).toEqual(before)
  })

  it('plans exactly what the equivalent flags plan', async () => {
    machine.detected = ['claude', 'codex']
    const flagsFor = (...argv: string[]): InitOptions => {
      const program = new Command().exitOverride()
      registerInitCommand(program)
      const init = program.commands.find(command => command.name() === 'init')!
      init.action(() => {})
      program.parse(['init', ...argv], { from: 'user' })
      return normalizeInitOptions(init.opts<InitOptions>())
    }

    const running = runInitWizard({
      cwd: projectDir,
      options: {},
      ui: driver.ui,
      plan: planInit,
      detect: () => AGENT_IDS.map(agent => ({ agent, detected: machine.detected.includes(agent), evidence: [] })),
      launchWarning: null,
      agentUrlWarning: AGENT_URL_MISSING_WARNING,
    })
    for (const [question, answer] of [
      ['Where should the board live?', enter],
      ['Card numbers start with', typeLine('wx1')],
      ['Which columns should the board start with?', d => d.press('down', 'down', 'enter')],
      ['Which coding agents do you use here?', enter],
      ['Connect them now?', enter],
      ['Keep all of them?', enter],
      ['Add a first card?', typeLine('Check the sensors')],
      ['Write these changes?', enter],
    ] satisfies Step[]) {
      await driver.waitFor(question)
      answer(driver)
    }
    const answered = await running

    const fromFlags = await planInit(projectDir, flagsFor('--key', 'wx1', '--columns', 'review-qa', '--connect', 'claude,codex', '--first-card', 'Check the sensors'))
    expect(answered.plan).toEqual(fromFlags)
    expect(answered.plan.connect?.items.map(item => item.kind)).toEqual(['instructions', 'instructions', 'mcp', 'mcp'])
  })
})

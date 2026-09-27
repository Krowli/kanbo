import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { PassThrough } from 'node:stream'

import type { CommanderError } from 'commander'
import { Command } from 'commander'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { APPROVED_COMMENT } from '../ops/approval'
import type { PromptDriver } from '../testing/prompt-driver'
import { createPromptDriver } from '../testing/prompt-driver'
import { openBoardSession } from './command'
import { registerKanboCommands } from './commands'
import { runKanbo } from './program'
import type { AgentDetection } from './setup/agents'
import { CancelledError, createUi, setUiForTests } from './ui/ui'

/**
 * `kanbo` with no words: the hint when nobody can be asked, the wizard in a
 * folder with no board, and the home screen — kept as golden transcripts in
 * `src/cli/__golden__/home-*.txt`, answered key by key through the prompt
 * driver. Which agents are "found" is pinned, as in the wizard's tests.
 */
const machine = vi.hoisted(() => ({ detected: [] as string[] }))

vi.mock('./setup/agents', async (importOriginal) => {
  const original = await importOriginal<typeof import('./setup/agents')>()
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

vi.mock('./setup/launch-warning', async (importOriginal) => {
  const original = await importOriginal<typeof import('./setup/launch-warning')>()
  return { ...original, readLaunchWarning: () => null }
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

describe('kanbo with no words', () => {
  let root: string
  let home: string
  let projectDir: string
  let driver: PromptDriver
  let printed: string[]

  beforeAll(async () => {
    // The prompt library picks its glyphs once, when it loads (see the wizard's tests).
    vi.stubEnv('WT_SESSION', 'kanbo-golden')
    await import('@clack/prompts')
    vi.unstubAllEnvs()
  })

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'kanbo-home-')))
    home = join(root, 'home')
    projectDir = join(root, 'weather-station')
    mkdirSync(home)
    mkdirSync(projectDir)
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir)
    for (const name of ['KANBO_DB_PATH', 'KANBO_WORKSPACE_ID', 'KANBO_DATABASE_URL', 'KANBO_ACTOR_KIND', 'CI', 'TERM', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GEMINI_CLI_HOME']) {
      vi.stubEnv(name, undefined)
    }
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    machine.detected = []
    driver = createPromptDriver()
    setUiForTests(driver.ui)
    // What commands print lands in the transcript, where a person sees it.
    printed = []
    const print = (...values: unknown[]): void => {
      const line = values.map(String).join(' ')
      printed.push(line)
      driver.ui.output.write(`${line}\n`)
    }
    vi.spyOn(console, 'log').mockImplementation(print)
    vi.spyOn(console, 'error').mockImplementation(print)
  })

  afterEach(() => {
    setUiForTests(null)
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    rmSync(root, { force: true, recursive: true })
  })

  const program = (): Command => {
    const created = new Command().name('kanbo').exitOverride().configureOutput({ writeErr: text => printed.push(text), writeOut: text => printed.push(text) })
    registerKanboCommands(created)
    return created
  }

  /** `kanbo <args>`; settles with the error it stopped on, or `null`. */
  const kanbo = (...args: string[]): Promise<unknown> => runKanbo(args, program).then(() => null, (error: unknown) => error)

  /** Nobody at a terminal: streams that are not one. */
  function withoutTerminal(): void {
    setUiForTests(createUi({ input: new PassThrough(), output: new PassThrough() }))
  }

  /** A board of this folder's own, as `kanbo init --yes` makes it, with nothing printed yet. */
  async function createBoard(): Promise<void> {
    expect(await kanbo('init', '--yes')).toBeNull()
    printed = []
    driver = createPromptDriver()
    setUiForTests(driver.ui)
  }

  /** Two cards an agent handed to a person: one with a comment on it. */
  async function createWaitingCards(): Promise<void> {
    vi.stubEnv('KANBO_ACTOR_KIND', 'agent')
    for (const title of ['Fix the login form', 'Add a dark theme']) {
      expect(await kanbo('card', 'create', '--title', title, '--column', 'in_review')).toBeNull()
    }
    expect(await kanbo('card', 'comment', 'WST-002', '--content', 'Toggle is in Settings.\nScreenshots attached.')).toBeNull()
    expect(await kanbo('card', 'wait-approval', 'WST-001', '--text', 'login fixed, please check')).toBeNull()
    expect(await kanbo('card', 'wait-approval', 'WST-002', '--text', 'dark theme ready')).toBeNull()
    vi.stubEnv('KANBO_ACTOR_KIND', undefined)
    printed = []
    driver = createPromptDriver()
    setUiForTests(driver.ui)
  }

  /** The transcript as the golden file keeps it: machine paths replaced, trailing spaces dropped. */
  function transcript(outcome: unknown): string {
    const text = driver.transcript()
      .replaceAll(projectDir, '<project>')
      .replaceAll(root, '<root>')
      .split('\n')
      .map(line => line.trimEnd())
      .join('\n')
    const ending = outcome === null ? 'exit 0' : `exit ${(outcome as { exitCode?: number }).exitCode ?? '?'}: ${(outcome as Error).message}`
    return `${text}\n--- ${ending}\n`
  }

  const golden = (name: string): string => join(__dirname, '__golden__', `home-${name}.txt`)

  const exitMenu = (d: PromptDriver): void => d.press('down', 'down', 'down', 'down', 'down', 'down', 'down', 'enter')

  async function readCard(key: string): Promise<{ column: string | undefined, waitingFor: string | null, comments: string[] }> {
    const session = await openBoardSession({}, 'read')
    try {
      const card = (await session.store.issues.findInWorkspace(session.workspace.id, key))!
      const columns = await session.ops.listColumns(session.workspace.id)
      const comments = await session.store.comments.listByIssue(card.id)
      return {
        column: columns.find(column => column.id === card.statusId)?.name,
        waitingFor: card.waitingFor,
        comments: comments.map(comment => comment.content),
      }
    }
    finally {
      await session.close()
    }
  }

  describe('with nobody to ask', () => {
    it('prints how to set a board up, and exits 0, in a folder with no board', async () => {
      withoutTerminal()

      expect(await kanbo()).toBeNull()

      expect(printed.join('\n')).toBe([
        'This folder has no kanbo board yet.',
        'Set one up with the defaults (board file in .kanbo/, no agent files touched):  kanbo init --yes',
        'Also connect Claude Code:  kanbo init --yes --connect claude',
      ].join('\n'))
      expect(snapshot(projectDir)).toEqual({})
    })

    it('tells an agent to ask a person, without a question even at a terminal', async () => {
      vi.stubEnv('CLAUDECODE', '1')

      expect(await kanbo()).toBeNull()

      expect(printed[0]!.split('\n')[0]).toBe('This folder has no kanbo board yet. Ask a person to run kanbo here.')
      expect(printed.join('\n')).toContain('kanbo init --yes --connect claude')
      expect(driver.transcript()).toBe(printed.join('\n').concat('\n'))
      expect(snapshot(projectDir)).toEqual({})
    })

    it('summarises the board in a few plain lines', async () => {
      machine.detected = ['claude']
      await createBoard()
      await createWaitingCards()
      withoutTerminal()

      expect(await kanbo()).toBeNull()

      expect(printed.join('\n')).toBe([
        'kanbo · weather-station (WST) · .kanbo/board.db',
        'Backlog 0 · To Do 0 · In Progress 0 · In Review 2 · Done 0',
        '2 cards waiting for you',
        'Agents: Claude Code — not connected',
        'More: kanbo --help',
      ].join('\n'))
    })
  })

  it('opens the init wizard in a folder with no board, and Ctrl-C leaves it as it was', async () => {
    const before = snapshot(projectDir)
    const running = kanbo()
    await driver.waitFor('kanbo — set up a board for this project')
    await driver.waitFor('Where should the board live?')
    driver.press('ctrl-c')
    const outcome = await running

    expect(outcome).toBeInstanceOf(CancelledError)
    expect((outcome as Error).message).toBe('Cancelled — nothing was written.')
    expect(snapshot(projectDir)).toEqual(before)
  })

  it('adds a card from the home screen, then exits', async () => {
    machine.detected = ['claude']
    await createBoard()

    const running = kanbo()
    await driver.waitFor('What next?')
    driver.press('down', 'down', 'enter')
    await driver.waitFor('What is the card about?')
    driver.type('Write the README')
    driver.press('enter')
    await driver.waitFor('What next?')
    exitMenu(driver)
    const outcome = await running

    expect(outcome).toBeNull()
    await expect(transcript(outcome)).toMatchFileSnapshot(golden('add-card'))
    expect(await readCard('WST-001')).toMatchObject({ column: 'To Do', waitingFor: null })
  })

  it('reviews the waiting cards: approves one, sends the other back with a comment', async () => {
    await createBoard()
    await createWaitingCards()

    const running = kanbo()
    await driver.waitFor('What next?')
    driver.press('enter')
    await driver.waitFor('What about WST-001?')
    driver.press('enter')
    await driver.waitFor('What about WST-002?')
    driver.press('down', 'enter')
    await driver.waitFor('What should change?')
    driver.type('Keep the light theme the default')
    driver.press('enter')
    await driver.waitFor('What next?')
    exitMenu(driver)
    const outcome = await running

    expect(outcome).toBeNull()
    await expect(transcript(outcome)).toMatchFileSnapshot(golden('review'))
    const approved = await readCard('WST-001')
    expect(approved).toMatchObject({ column: 'In Review', waitingFor: null })
    expect(approved.comments.at(-1)).toBe(APPROVED_COMMENT)
    const returned = await readCard('WST-002')
    expect(returned).toMatchObject({ column: 'In Progress', waitingFor: null })
    expect(returned.comments.at(-1)).toContain('Keep the light theme the default')
  })

  it('opens the columns menu from Change columns, and comes back to the home screen', async () => {
    await createBoard()

    const running = kanbo()
    await driver.waitFor('What next?')
    driver.press('down', 'down', 'down', 'down', 'down', 'enter')
    await driver.waitFor('Columns of this board:')
    await driver.waitFor('What would you like to change?')
    driver.press('up', 'enter') // Done
    await driver.waitFor('What next?')
    exitMenu(driver)

    expect(await running).toBeNull()
  })

  it('leaves quietly with exit 0 on Ctrl-C at the menu', async () => {
    await createBoard()

    const running = kanbo()
    await driver.waitFor('What next?')
    driver.press('ctrl-c')

    expect(await running).toBeNull()
    expect(printed).toEqual([])
  })

  it.each([
    ['frobnicate', 'error: unknown command \'frobnicate\''],
    ['conect', '(Did you mean connect?)'],
  ])('keeps commander\'s error for an unknown word (%s)', async (word, said) => {
    const outcome = await kanbo(word)

    expect((outcome as CommanderError).code).toBe('commander.unknownCommand')
    expect((outcome as CommanderError).exitCode).toBe(1)
    expect(printed.join('')).toContain(said)
  })
})

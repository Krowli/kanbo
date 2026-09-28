import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { PassThrough } from 'node:stream'

import type { CommanderError } from 'commander'
import { Command } from 'commander'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { APPROVED_COMMENT } from '../ops/approval'
import type { PromptDriver } from '../testing/prompt-driver'
import { createPromptDriver } from '../testing/prompt-driver'
import { describePersonOverride } from './actor'
import { readBinding } from './binding'
import { openBoardSession } from './command'
import { registerKanboCommands } from './commands'
import { createKanboProgram, runKanbo } from './program'
import type { AgentDetection } from './setup/agents'
import { CancelledError, createUi, setUiForTests } from './ui/ui'
import type { UpdateInstaller } from './update-check'

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

      expect(printed[0]!.split('\n').slice(0, 2)).toEqual([
        'This folder has no kanbo board yet. Ask a person to run kanbo here.',
        describePersonOverride([]),
      ])
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

    it('names a board file outside home by its whole path, even when it starts like the home folder', async () => {
      // HOME is <root>/home; the board is at <root>/homebase/board.db.
      expect(await kanbo('init', '--yes', '--file', '../homebase/board.db')).toBeNull()
      printed = []
      withoutTerminal()

      expect(await kanbo()).toBeNull()

      expect(printed[0]!.split('\n')[0]).toBe(`kanbo · weather-station (WST) · ${join(root, 'homebase', 'board.db').replaceAll('\\', '/')}`)
    })
  })

  describe('when the board file is gone', () => {
    const boardFile = (): string => join(projectDir, '.kanbo', 'board.db')

    it('says what to do with nobody to ask, and exits 2', async () => {
      await createBoard()
      rmSync(boardFile())
      withoutTerminal()

      const outcome = await kanbo()

      expect(outcome).toMatchObject({
        exitCode: 2,
        message: `This project's board file is missing: ${boardFile()}. Create a new empty board here: kanbo init --file (the old cards are gone), or restore the file.`,
      })
      expect(existsSync(boardFile())).toBe(false)
    })

    it('offers a new empty board where the old one was, and makes it on a yes', async () => {
      await createBoard()
      rmSync(boardFile())

      const running = kanbo()
      await driver.waitFor(`This project's board file is missing: ${boardFile()}.`)
      await driver.waitFor('Create a new empty board at .kanbo/board.db (the old cards are gone)')
      driver.press('enter')
      for (const question of ['Which columns should the board start with?', 'Which coding agents do you use here?', 'Add a first card?', 'Write these changes?']) {
        await driver.waitFor(question)
        driver.press('enter')
      }
      const outcome = await running

      expect(outcome).toBeNull()
      expect(driver.transcript()).not.toContain('Run kanbo to set one up')
      expect(existsSync(boardFile())).toBe(true)
      expect(readBinding(join(projectDir, '.kanbo', 'binding.json'))).toMatchObject({ workspaceId: 'weather-station', identifier: 'WST' })
    })

    it('writes nothing on Cancel', async () => {
      await createBoard()
      rmSync(boardFile())
      const before = snapshot(projectDir)

      const running = kanbo()
      await driver.waitFor('What now?')
      driver.press('down', 'enter')
      const outcome = await running

      expect(outcome).toBeInstanceOf(CancelledError)
      expect((outcome as Error).message).toBe('Cancelled — nothing was written.')
      expect(snapshot(projectDir)).toEqual(before)
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

  it('comes back to the menu when commander refuses the words of a menu item, instead of ending kanbo', async () => {
    await createBoard()
    const exit = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`process.exit(${code})`)
    })
    // The real program, with its commands already registered — and a `board`
    // that now wants a word the menu does not give it.
    const strict = (): Command => {
      const created = createKanboProgram().configureOutput({ writeErr: text => printed.push(text), writeOut: text => printed.push(text) })
      created.commands.find(command => command.name() === 'board')!.argument('<which>')
      return created
    }

    const running = runKanbo([], strict).then(() => null, (error: unknown) => error)
    await driver.waitFor('What next?')
    driver.press('enter') // Show the board here
    await driver.waitFor('What next?') // back at the menu
    exitMenu(driver)

    expect(await running).toBeNull()
    expect(exit).not.toHaveBeenCalled()
    expect(printed.join('')).toContain('error: missing required argument \'which\'')
  })

  it('serves the board page in the foreground until Ctrl-C, then closes it and brings the menu back', async () => {
    await createBoard()
    let stop = (): void => {}
    const close = vi.fn(async () => {})
    const start = vi.fn(async () => ({ link: 'http://127.0.0.1:4318/#token=t', close }))
    const waitForStop = vi.fn(() => new Promise<void>((resolve) => {
      stop = resolve
    }))

    const running = runKanbo([], program, { boardPage: { start, waitForStop } }).then(() => null, (error: unknown) => error)
    await driver.waitFor('What next?')
    driver.press('down', 'enter') // Open the board in your browser
    await driver.waitFor('Board open at http://127.0.0.1:4318/#token=t — press Ctrl-C to stop and return to the menu')
    // Still serving: no menu, nothing closed.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(driver.transcript().split('Board open at')[1]).not.toContain('What next?')
    expect(close).not.toHaveBeenCalled()

    stop()
    await driver.waitFor('What next?')
    expect(close).toHaveBeenCalledTimes(1)
    exitMenu(driver)

    expect(await running).toBeNull()
    expect(start).toHaveBeenCalledTimes(1)
  })

  /** npm answering `latest` with this version. */
  const npmSays = (version: string): ReturnType<typeof vi.fn<typeof globalThis.fetch>> =>
    vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ version })))
  const installed = (): ReturnType<typeof vi.fn<UpdateInstaller>> => vi.fn<UpdateInstaller>(() => ({ pid: 1, output: [], stdout: '', stderr: '', status: 0, signal: null }))
  const NOTICE = 'kanbo 9.0.0 is available (you have 0.3.0) — npm install -g kanbo-cli@latest'
  const WINDOWS_NOTICE = 'kanbo 9.0.0 is available (you have 0.3.0). Close kanbo and run: npm install -g kanbo-cli@latest'

  it('shows a newer kanbo under the summary, installs it from the menu, and leaves the menu', async () => {
    await createBoard()
    const install = installed()

    const running = runKanbo([], program, {}, { fetch: npmSays('9.0.0'), env: {}, currentVersion: '0.3.0', install, platform: 'darwin' }).then(() => null, (error: unknown) => error)
    await driver.waitFor('kanbo 9.0.0 is available (you have 0.3.0).')
    await driver.waitFor('Update kanbo to 9.0.0 — npm install -g kanbo-cli@latest')
    driver.press('down', 'down', 'down', 'down', 'down', 'down', 'down', 'enter')

    // No Exit pressed: a successful update ends the menu by itself.
    expect(await running).toBeNull()
    expect(install).toHaveBeenCalledOnce()
    expect(printed).toEqual(['Updated to 9.0.0 — start kanbo again to use it.'])
    const afterInstall = driver.transcript().split('Updated to 9.0.0')[1]!
    expect(afterInstall).not.toContain('What next?')
    expect(afterInstall).not.toContain('Update now?')
  })

  it('stays in the menu when the update from the menu fails, without offering it again', async () => {
    await createBoard()
    const install = vi.fn(() => ({ pid: 1, output: [], stdout: '', stderr: '', status: 1, signal: null }))

    const running = runKanbo([], program, {}, { fetch: npmSays('9.0.0'), env: {}, currentVersion: '0.3.0', install, platform: 'darwin' }).then(() => null, (error: unknown) => error)
    await driver.waitFor('Update kanbo to 9.0.0')
    driver.press('down', 'down', 'down', 'down', 'down', 'down', 'down', 'enter')
    await driver.waitFor('kanbo was not updated')
    await driver.waitFor('What next?')
    exitMenu(driver)

    expect(await running).toBeNull()
    expect(printed).toEqual(['kanbo was not updated: npm exited with code 1. Run it yourself: npm install -g kanbo-cli@latest'])
  })

  it.each([
    ['Exit', (d: PromptDriver): void => d.press('down', 'down', 'down', 'down', 'down', 'down', 'down', 'down', 'enter')],
    ['Ctrl-C', (d: PromptDriver): void => d.press('ctrl-c')],
  ])('says a newer kanbo in one line, with no question, on leaving the menu with %s', async (_label, leave) => {
    await createBoard()
    const install = installed()

    const running = runKanbo([], program, {}, { fetch: npmSays('9.0.0'), env: {}, currentVersion: '0.3.0', install, platform: 'darwin' }).then(() => null, (error: unknown) => error)
    await driver.waitFor('Update kanbo to 9.0.0')
    leave(driver)

    expect(await running).toBeNull()
    expect(printed).toEqual([NOTICE])
    expect(install).not.toHaveBeenCalled()
    expect(driver.transcript()).not.toContain('Update now?')
  })

  it('waits for an answer that comes just after the person leaves the menu', async () => {
    await createBoard()
    let answer!: () => void
    const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise<Response>((resolve) => {
      answer = () => resolve(new Response(JSON.stringify({ version: '9.0.0' })))
    }))

    const running = runKanbo([], program, {}, { fetch, env: {}, currentVersion: '0.3.0', platform: 'darwin' }).then(() => null, (error: unknown) => error)
    await driver.waitFor('What next?')
    exitMenu(driver)
    await new Promise(resolve => setTimeout(resolve, 20))
    answer()

    expect(await running).toBeNull()
    expect(printed).toEqual([NOTICE])
  })

  it('on Windows, the menu item says how to update after closing kanbo, and installs nothing', async () => {
    await createBoard()
    const install = installed()

    const running = runKanbo([], program, {}, { fetch: npmSays('9.0.0'), env: {}, currentVersion: '0.3.0', install, platform: 'win32' }).then(() => null, (error: unknown) => error)
    await driver.waitFor('How to update kanbo to 9.0.0 — npm install -g kanbo-cli@latest')
    driver.press('down', 'down', 'down', 'down', 'down', 'down', 'down', 'enter')
    await driver.waitFor(WINDOWS_NOTICE)
    await driver.waitFor('What next?')
    exitMenu(driver)

    expect(await running).toBeNull()
    expect(install).not.toHaveBeenCalled()
    // Said once: not again on leaving.
    expect(printed).toEqual([WINDOWS_NOTICE])
  })

  it('for a project\'s own install, the menu item gives the project\'s command and installs nothing', async () => {
    await createBoard()
    const install = installed()
    const notice = 'kanbo 9.0.0 is available (you have 0.3.0). This project installs kanbo; update it here: npm install kanbo-cli@latest'

    const running = runKanbo([], program, {}, { fetch: npmSays('9.0.0'), env: {}, currentVersion: '0.3.0', install, platform: 'darwin', installKind: 'project' }).then(() => null, (error: unknown) => error)
    await driver.waitFor('How to update kanbo to 9.0.0 — npm install kanbo-cli@latest')
    driver.press('down', 'down', 'down', 'down', 'down', 'down', 'down', 'enter')
    await driver.waitFor(notice)
    await driver.waitFor('What next?')
    exitMenu(driver)

    expect(await running).toBeNull()
    expect(install).not.toHaveBeenCalled()
    expect(printed).toEqual([notice])
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

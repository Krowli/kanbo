import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { Command } from 'commander'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BoardStore } from '../board-store'
import type { BoardWorkspaceIdentity } from '../domain/numbering'
import { createCard } from '../ops/cards'
import { readChangeSeq } from '../ops/change-seq'
import { ensureDefaultColumns, listColumns, setColumnEntryRules } from '../ops/columns'
import type { BoardActor } from '../ops/types'
import { createSqliteBoardStore } from '../sqlite/board-store.sqlite'
import type { TestBoardDatabase } from '../testing/board-database'
import { createTestBoardDatabase, seedHostWorkspace } from '../testing/board-database'
import type { PromptDriver } from '../testing/prompt-driver'
import { createPromptDriver } from '../testing/prompt-driver'
import { COLUMN_CHANGES_ARE_HUMAN_MESSAGE } from './actor'
import { registerCardCommands } from './commands/card'
import { registerColumnsCommands } from './commands/columns'
import { describeFailure } from './failure'
import { createUi, setUiForTests } from './ui/ui'

const WORKSPACE: BoardWorkspaceIdentity = { id: 'workspace', identifier: 'WOR', name: 'Workspace' }
const USER: BoardActor = { kind: 'user', id: '__self__' }
const STANDARD = ['Backlog', 'To Do', 'In Progress', 'In Review', 'Done', 'Canceled']

/**
 * `kanbo columns add|rename|move|remove|template` and `kanbo columns` alone,
 * from a terminal: what each does to the board, what each refuses, the
 * refusal in an agent's shell, and — through the prompt driver — the questions
 * `remove` asks at a terminal and the menu, kept as a golden transcript in
 * `src/cli/__golden__/columns-menu.txt`.
 */
describe('kanbo columns', () => {
  let board: TestBoardDatabase
  let store: BoardStore
  let printed: string[]
  let driver: PromptDriver

  beforeAll(async () => {
    // The prompt library picks its glyphs once, when it loads (see the wizard's tests).
    vi.stubEnv('WT_SESSION', 'kanbo-golden')
    await import('@clack/prompts')
    vi.unstubAllEnvs()
  })

  beforeEach(async () => {
    board = await createTestBoardDatabase()
    seedHostWorkspace(board, WORKSPACE.id, WORKSPACE.identifier)
    store = createSqliteBoardStore({ database: () => board.database })
    await ensureDefaultColumns(store, WORKSPACE.id)
    for (const name of ['KANBO_ACTOR_KIND', 'CI', 'TERM']) {
      vi.stubEnv(name, undefined)
    }
    // `kanbo columns` alone takes no options: the board comes from the environment.
    vi.stubEnv('KANBO_DB_PATH', board.path)
    vi.stubEnv('KANBO_WORKSPACE_ID', WORKSPACE.id)
    printed = []
    const print = (...values: unknown[]): void => {
      const line = values.map(String).join(' ')
      printed.push(line)
      driver.ui.output.write(`${line}\n`)
    }
    vi.spyOn(console, 'log').mockImplementation(print)
    vi.spyOn(console, 'error').mockImplementation(print)
    // Nobody at a terminal, unless a test says otherwise.
    driver = createPromptDriver()
    setUiForTests(createUi({ input: new PassThrough(), output: new PassThrough() }))
  })

  afterEach(() => {
    setUiForTests(null)
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    board.dispose()
  })

  function program(): Command {
    const created = new Command().exitOverride().configureOutput({ writeErr: text => printed.push(text), writeOut: text => printed.push(text) })
    registerColumnsCommands(created)
    registerCardCommands(created)
    return created
  }

  /** `kanbo <args>`; settles with the error it stopped on, or `null`. */
  async function kanbo(...args: string[]): Promise<unknown> {
    return await program().parseAsync(args, { from: 'user' }).then(() => null, (error: unknown) => error)
  }

  /** A person at the prompt driver's terminal. */
  function atTerminal(): void {
    setUiForTests(driver.ui)
  }

  const names = async (): Promise<string[]> => (await listColumns(store, WORKSPACE.id)).map(column => column.name)
  const message = (outcome: unknown): string => describeFailure(outcome).message

  async function addCards(column: string, count: number): Promise<string[]> {
    const ids: string[] = []
    for (let index = 0; index < count; index++) {
      ids.push((await createCard(store, { workspace: WORKSPACE, title: `Card ${index}`, statusName: column }, USER)).id)
    }
    return ids
  }

  async function columnOf(cardId: string): Promise<string | undefined> {
    const card = await store.issues.findById(cardId)
    return (await listColumns(store, WORKSPACE.id)).find(column => column.id === card?.statusId)?.name
  }

  describe('add', () => {
    it('puts a column after the one named, with its line and category', async () => {
      expect(await kanbo('columns', 'add', 'Design', '--after', 'backlog', '--description', 'Being sketched', '--category', 'unstarted')).toBeNull()

      expect(await names()).toEqual(['Backlog', 'Design', 'To Do', 'In Progress', 'In Review', 'Done', 'Canceled'])
      expect((await listColumns(store, WORKSPACE.id))[1]).toMatchObject({ description: 'Being sketched', category: 'unstarted' })
      expect(printed.join('\n')).toContain('Added Design (slug design).')
    })

    it('puts a column before Done when told nothing, and a ready-made name brings its own line', async () => {
      expect(await kanbo('columns', 'add', 'qa')).toBeNull()

      expect(await names()).toEqual(['Backlog', 'To Do', 'In Progress', 'In Review', 'qa', 'Done', 'Canceled'])
      expect((await listColumns(store, WORKSPACE.id))[4]).toMatchObject({ description: 'Being tested before it counts as done', category: 'started' })
    })

    it('puts a column before the one named, in one board change', async () => {
      const before = await readChangeSeq(store)

      expect(await kanbo('columns', 'add', 'Blocked', '--before', 'in-progress')).toBeNull()

      expect(await readChangeSeq(store)).toBe(before + 1)
      expect((await listColumns(store, WORKSPACE.id)).map(column => column.order)).toEqual([0, 1, 2, 3, 4, 5, 6])

      expect(await names()).toEqual(['Backlog', 'To Do', 'Blocked', 'In Progress', 'In Review', 'Done', 'Canceled'])
    })

    it.each([
      [['In-Review'], 'This board already has a column called In Review (slug in_review).'],
      [['QA', '--after', 'done', '--before', 'backlog'], 'Pass --after or --before, not both.'],
      [['QA', '--after', 'nowhere'], 'This board has no column "nowhere". See kanbo columns list.'],
    ])('refuses %j and adds nothing', async (args, said) => {
      const before = await readChangeSeq(store)

      const outcome = await kanbo('columns', 'add', ...args)

      expect(message(outcome)).toBe(said)
      expect(await names()).toEqual(STANDARD)
      expect(await readChangeSeq(store)).toBe(before)
    })
  })

  describe('rename', () => {
    it('renames a column; cards follow it', async () => {
      const [card] = await addCards('In Review', 1)

      expect(await kanbo('columns', 'rename', 'in_review', 'Code Review')).toBeNull()

      expect(await names()).toEqual(['Backlog', 'To Do', 'In Progress', 'Code Review', 'Done', 'Canceled'])
      expect(await columnOf(card!)).toBe('Code Review')
      expect(printed.join('\n')).toContain('Renamed In Review to Code Review (slug code_review).\n'
        + 'Agents read column names from kanbo prime; rename is picked up there.')
    })

    it('refuses a name another column answers to', async () => {
      const outcome = await kanbo('columns', 'rename', 'backlog', 'done')

      expect(message(outcome)).toBe('Another column, Done, already has that name (same slug). Pick another name.\n'
        + '  Next: kanbo columns list  [board_column_name_taken]')
      expect(await names()).toEqual(STANDARD)
    })

    it('refuses renaming To Do away from its slug, saying why', async () => {
      const outcome = await kanbo('columns', 'rename', 'to_do', 'Ready')

      expect(message(outcome)).toBe('To Do can\'t be renamed to "Ready": kanbo ready takes work from To Do, and agents '
        + 'would find no cards to take. Another spelling of To Do (To-do, TO DO) is fine.  [board_column_ready_protected]')
      expect(await names()).toEqual(STANDARD)
    })
  })

  describe('move', () => {
    it.each([
      [['--first'], ['Done', 'Backlog', 'To Do', 'In Progress', 'In Review', 'Canceled'], 'Moved Done to the start.'],
      [['--last'], ['Backlog', 'To Do', 'In Progress', 'In Review', 'Canceled', 'Done'], 'Moved Done to the end.'],
      [['--before', 'to_do'], ['Backlog', 'Done', 'To Do', 'In Progress', 'In Review', 'Canceled'], 'Moved Done before To Do.'],
      [['--after', 'in_progress'], ['Backlog', 'To Do', 'In Progress', 'Done', 'In Review', 'Canceled'], 'Moved Done after In Progress.'],
    ])('moves a column %j', async (flags, expected, said) => {
      expect(await kanbo('columns', 'move', 'done', ...flags)).toBeNull()

      expect(await names()).toEqual(expected)
      expect(printed.join('\n')).toContain(said)
    })

    it.each([[[]], [['--first', '--last']]])('wants exactly one place (%j)', async (flags) => {
      const outcome = await kanbo('columns', 'move', 'done', ...flags)

      expect(message(outcome)).toBe('Say where the column goes: --first, --last, --before <column> or --after <column> (one of them).')
      expect(await names()).toEqual(STANDARD)
    })
  })

  describe('remove', () => {
    it('removes an empty column', async () => {
      expect(await kanbo('columns', 'remove', 'canceled')).toBeNull()

      expect(await names()).toEqual(['Backlog', 'To Do', 'In Progress', 'In Review', 'Done'])
      expect(printed.join('\n')).toContain('Removed Canceled.')
    })

    it('with nobody to ask, refuses a column that holds cards until told where they go, and leaves the cards', async () => {
      const cards = await addCards('In Review', 2)
      const before = await readChangeSeq(store)

      const outcome = await kanbo('columns', 'remove', 'in_review')

      expect(message(outcome)).toBe('In Review holds 2 cards. Say where they go.\n'
        + '  Next: kanbo columns remove in_review --move-cards-to <column>  [board_column_not_empty]')
      expect(describeFailure(outcome).exitCode).toBe(1)
      expect(await names()).toEqual(STANDARD)
      expect(await columnOf(cards[0]!)).toBe('In Review')
      expect(await readChangeSeq(store)).toBe(before)
    })

    it('moves the cards to the column named, and removes the column', async () => {
      const cards = await addCards('In Review', 2)

      expect(await kanbo('columns', 'remove', 'in_review', '--move-cards-to', 'in_progress')).toBeNull()

      expect(await names()).toEqual(['Backlog', 'To Do', 'In Progress', 'Done', 'Canceled'])
      expect(await columnOf(cards[0]!)).toBe('In Progress')
      expect(await columnOf(cards[1]!)).toBe('In Progress')
      expect(printed.join('\n')).toContain('Removed In Review and moved 2 cards to In Progress.')
    })

    it('warns about each moved card that enters a column without meeting its rules, as card move does', async () => {
      const [card] = await addCards('In Review', 1)
      await setColumnEntryRules(store, WORKSPACE.id, 'done', ['pull_request_linked'], USER)

      expect(await kanbo('columns', 'remove', 'in_review', '--move-cards-to', 'done')).toBeNull()

      expect(await columnOf(card!)).toBe('Done')
      expect(printed.join('\n')).toMatch(new RegExp(`kanbo: warning: ${card} entered "Done" without pull_request_linked: `))
    })

    it('never removes To Do', async () => {
      const outcome = await kanbo('columns', 'remove', 'to_do')

      expect(message(outcome)).toBe('To Do can\'t be removed: kanbo ready takes work from To Do, and agents would find no cards to take.  [board_column_ready_protected]')
      expect(await names()).toEqual(STANDARD)
    })

    it('at a terminal, asks where the cards go, then asks before removing', async () => {
      const cards = await addCards('In Review', 3)
      atTerminal()

      const running = kanbo('columns', 'remove', 'in_review')
      await driver.waitFor('In Review holds 3 cards. Move them to which column?')
      driver.press('down', 'enter') // Backlog, To Do → To Do
      await driver.waitFor('Remove column In Review and move 3 cards to To Do?')
      driver.press('up', 'enter') // Yes
      expect(await running).toBeNull()

      expect(await names()).toEqual(['Backlog', 'To Do', 'In Progress', 'Done', 'Canceled'])
      for (const card of cards) {
        expect(await columnOf(card)).toBe('To Do')
      }
    })

    it('at a terminal, No leaves the board as it was', async () => {
      await addCards('In Review', 1)
      atTerminal()
      const before = await readChangeSeq(store)

      const running = kanbo('columns', 'remove', 'in_review')
      await driver.waitFor('Move them to which column?')
      driver.press('enter')
      await driver.waitFor('Remove column In Review and move 1 card to Backlog?')
      driver.press('enter') // No is the default
      expect(await running).toBeNull()

      expect(printed).toContain('Nothing removed.')
      expect(await names()).toEqual(STANDARD)
      expect(await readChangeSeq(store)).toBe(before)
    })
  })

  describe('template', () => {
    it('adds the columns of a template the board lacks, and nothing the second time', async () => {
      expect(await kanbo('columns', 'template', 'review-qa', '--add-missing')).toBeNull()
      const after = await readChangeSeq(store)
      expect(await kanbo('columns', 'template', 'review-qa', '--add-missing')).toBeNull()

      expect(await names()).toEqual(['Backlog', 'To Do', 'In Progress', 'In Review', 'QA', 'Done', 'Canceled'])
      expect(printed.join('\n')).toContain('Added QA.')
      expect(printed.join('\n')).toContain('This board already has every Review + QA column.')
      expect(await readChangeSeq(store)).toBe(after)
    })

    it('puts a template on an empty board as it is', async () => {
      for (const column of await listColumns(store, WORKSPACE.id)) {
        await store.statuses.delete(column.id)
      }

      expect(await kanbo('columns', 'template', 'simple')).toBeNull()

      expect(await names()).toEqual(['To Do', 'In Progress', 'Done'])
    })

    it.each([
      [['simple'], 'This board already has columns. Add the Simple columns it lacks with: kanbo columns template simple --add-missing'],
      [['kanban'], 'Unknown template "kanban". Use standard, simple, review-qa.'],
    ])('refuses %j', async (args, said) => {
      expect(message(await kanbo('columns', 'template', ...args))).toBe(said)
      expect(await names()).toEqual(STANDARD)
    })

    it('keeps add-standard, the standard template\'s missing columns', async () => {
      const canceled = (await listColumns(store, WORKSPACE.id)).at(-1)!
      await store.statuses.delete(canceled.id)

      expect(await kanbo('columns', 'add-standard')).toBeNull()

      expect(await names()).toEqual(STANDARD)
      expect(printed.join('\n')).toContain('Added Canceled')
    })
  })

  it.each([
    [['add', 'QA']],
    [['rename', 'done', 'Shipped']],
    [['move', 'done', '--first']],
    [['remove', 'canceled']],
    [['template', 'review-qa', '--add-missing']],
    [['add-standard']],
  ])('refuses columns %j in an agent\'s shell with exit 4, and changes nothing', async (args) => {
    vi.stubEnv('KANBO_ACTOR_KIND', 'agent')
    const before = await readChangeSeq(store)

    const outcome = await kanbo('columns', ...args)

    expect(outcome).toMatchObject({ exitCode: 4, message: COLUMN_CHANGES_ARE_HUMAN_MESSAGE })
    expect(await names()).toEqual(STANDARD)
    expect(await readChangeSeq(store)).toBe(before)
  })

  it('lists the columns when run alone with nobody to ask', async () => {
    expect(await kanbo('columns')).toBeNull()

    expect(printed.join('\n').split('\n')[0]).toBe('backlog      Backlog — Ideas and requests, not ready to start')
  })

  it('refuses a word that is no subcommand', async () => {
    const outcome = await kanbo('columns', 'frobnicate')

    expect(outcome).toMatchObject({ code: 'commander.unknownCommand', exitCode: 1 })
    expect(printed.join('')).toContain('error: unknown command \'frobnicate\'')
  })

  it('run alone at a terminal, shows the columns and a menu: adds QA, then Done', async () => {
    atTerminal()

    const running = kanbo('columns')
    await driver.waitFor('What would you like to change?')
    driver.press('enter') // Add a column
    await driver.waitFor('What is the new column called?')
    driver.type('QA')
    driver.press('enter')
    await driver.waitFor('When does a card belong here?')
    driver.type('Tested by a person')
    driver.press('enter')
    await driver.waitFor('Where should it go?')
    driver.press('enter') // after In Review, the default
    await driver.waitFor('What would you like to change?')
    driver.press('up', 'enter') // Done
    const outcome = await running

    expect(outcome).toBeNull()
    expect(await names()).toEqual(['Backlog', 'To Do', 'In Progress', 'In Review', 'QA', 'Done', 'Canceled'])
    expect((await listColumns(store, WORKSPACE.id))[4]).toMatchObject({ description: 'Tested by a person' })
    const transcript = driver.transcript().split('\n').map(line => line.trimEnd()).join('\n')
    await expect(`${transcript}\n--- exit 0\n`).toMatchFileSnapshot(join(__dirname, '__golden__', 'columns-menu.txt'))
  })

  it('says there is nothing to remove when To Do is the only column, and goes back to the menu', async () => {
    for (const column of await listColumns(store, WORKSPACE.id)) {
      if (column.name !== 'To Do') {
        await store.statuses.delete(column.id)
      }
    }
    atTerminal()

    const running = kanbo('columns')
    await driver.waitFor('What would you like to change?')
    driver.press('down', 'down', 'down', 'enter') // Remove a column
    await driver.waitFor('Nothing to remove — To Do always stays.')
    await driver.waitFor('What would you like to change?')
    driver.press('up', 'enter') // Done

    expect(await running).toBeNull()
    expect(await names()).toEqual(['To Do'])
  })
})

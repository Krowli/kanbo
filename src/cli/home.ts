import { isAbsolute, relative } from 'node:path'

import type { Command } from 'commander'
import { CommanderError } from 'commander'
import pc from 'picocolors'

import { cardDisplayTitle } from '../domain/card-display-title'
import { READY_COLUMN_SLUG } from '../domain/column-templates'
import type { BoardWorkspaceIdentity } from '../domain/numbering'
import { readIssuePrefix } from '../domain/numbering'
import type { IssueStatus } from '../sqlite/schema'
import { describePersonOverride, isAgentShell, requireHumanActor } from './actor'
import { openBoardSession } from './command'
import { checkAgent } from './commands/connect'
import type { RunningServe } from './commands/serve'
import { DEFAULT_SERVE_OPTIONS, startServe, waitForInterrupt } from './commands/serve'
import type { BoardTarget } from './db-target'
import { BoardFileMissingError, BoardNotFoundError, DATABASE_NOT_FOUND_AGENT_MESSAGE, resolveDbTarget } from './db-target'
import { findKanboProject } from './doctor'
import { describeFailure, paintFailure } from './failure'
import { AGENT_IDS, AGENTS, detectAgents } from './setup/agents'
import { tildify } from './tildify'
import type { Ui } from './ui/ui'
import { CancelledError } from './ui/ui'
import type { AvailableUpdate } from './update-check'
import type { CardView } from './view'
import { projectCard } from './view'

/**
 * `kanbo` with no words: where a person starts.
 *
 * In a folder with no board, a person at a terminal gets the init wizard —
 * exactly `kanbo init`. With a board, they get the home screen: what is on the
 * board, what waits for them, which agents are connected, and a menu whose
 * every item shows the command it runs, so the menu teaches the commands. The
 * menu runs those commands in this process, as if they were typed.
 *
 * Nobody to ask (no terminal, CI, an agent's shell) means no question at all:
 * a few plain lines that say where things stand and the command to type next,
 * and exit 0 — `kanbo` alone is never a mistake.
 */

export interface BareKanboContext {
  ui: Ui
  /** Is there a person to ask (`canPrompt`)? */
  interactive: boolean
  /** A fresh `kanbo` program to run one menu item's command on. */
  createProgram: () => Command
  /**
   * A newer kanbo, once the update check started with this run has heard of
   * one: the home screen shows it under the summary and offers to install it.
   */
  update?: HomeUpdate
  /** How "Open the board in your browser" serves the board and waits; `kanbo serve`'s own unless a test says otherwise. */
  boardPage?: BoardPageRunner
}

/** The update check as the home screen sees it: what npm said so far, and how to install it. */
export interface HomeUpdate {
  peek: () => AvailableUpdate | null
  /** Can the menu install it? Not on Windows, where the running kanbo cannot replace itself, and only a global install. */
  inPlace: boolean
  /** What updates this install (`UPDATE_COMMANDS`), shown in the menu item. */
  command: string
  /** Install it; `true` when it worked (a failure has been explained). */
  install: () => boolean
  /** Say it in one line with the command to run, for when the menu cannot install it. */
  tell: (update: AvailableUpdate) => void
}

/** Serving the board page from the menu: start it, then wait for the person to stop it. */
export interface BoardPageRunner {
  start: () => Promise<RunningServe>
  waitForStop: () => Promise<void>
}

const SERVE_FROM_MENU: BoardPageRunner = {
  start: () => startServe(DEFAULT_SERVE_OPTIONS, { status: line => console.error(line), page: () => {} }),
  waitForStop: waitForInterrupt,
}

/** What the home screen shows about the board. */
interface HomeBoard {
  header: string
  columns: { name: string, category: IssueStatus['category'], count: number }[]
  waiting: CardView[]
}

/** The `--check` instruction cells that mean a kanbo section is there and readable. */
const INSTRUCTION_BLOCK_PRESENT = new Set(['current', 'outdated', 'legacy', 'edited', 'newer', 'chosen'])

type MenuChoice = 'review' | 'board' | 'serve' | 'card' | 'connect' | 'instructions' | 'columns' | 'doctor' | 'update' | 'exit'

/**
 * `kanbo` with no words. Says `'home'` when it showed the home screen, which
 * offers a newer kanbo itself — nobody is asked again after it.
 */
export async function runBareKanbo(context: BareKanboContext): Promise<'home' | 'other'> {
  let target: BoardTarget | null
  try {
    target = findBoardTarget()
  }
  catch (error) {
    // The board file this project is bound to is gone: the wizard offers a new
    // one; with nobody to ask, the message says what to do.
    if (error instanceof BoardFileMissingError && context.interactive) {
      await runCommand(context, ['init'])
      return 'other'
    }
    throw error
  }
  if (!context.interactive) {
    console.log(target ? await describePlainly(target) : describeNoBoard())
    return 'other'
  }
  if (!target) {
    await runCommand(context, ['init'])
    return 'other'
  }
  await runHome(context, target)
  return 'home'
}

/** The board this folder works on, or `null` when nothing names one. */
function findBoardTarget(): BoardTarget | null {
  try {
    return resolveDbTarget({ cwd: process.cwd() })
  }
  catch (error) {
    if (error instanceof BoardNotFoundError && !(error instanceof BoardFileMissingError)) {
      return null
    }
    throw error
  }
}

/** What bare `kanbo` prints with no board and nobody to ask; an agent's shell gets its own first line. */
export const NO_BOARD_HINT = [
  'This folder has no kanbo board yet.',
  'Set one up with the defaults (board file in .kanbo/, no agent files touched):  kanbo init --yes',
  'Also connect Claude Code:  kanbo init --yes --connect claude',
] as const

export const NO_BOARD_AGENT_FIRST_LINE = DATABASE_NOT_FOUND_AGENT_MESSAGE

/** No board and nobody to ask: the commands that set one up. */
function describeNoBoard(): string {
  const [first, ...rest] = NO_BOARD_HINT
  return [...(isAgentShell() ? [NO_BOARD_AGENT_FIRST_LINE, describePersonOverride('kanbo')] : [first]), ...rest].join('\n')
}

/** A board and nobody to ask: the summary, and where to read more. */
async function describePlainly(target: BoardTarget): Promise<string> {
  return [...describeBoard(await readHomeBoard(target)), 'More: kanbo --help'].join('\n')
}

async function runHome(context: BareKanboContext, target: BoardTarget): Promise<void> {
  const { ui } = context
  let told = false
  while (true) {
    const board = await readHomeBoard(target)
    // Looked at on every turn: npm's answer may come after the first screen.
    const update = told ? null : context.update?.peek() ?? null
    say(ui, ['', ...describeBoard(board), ...(update ? [pc.dim(`kanbo ${update.latest} is available (you have ${update.current}).`)] : [])].join('\n'))

    let choice: MenuChoice
    try {
      choice = await ui.select<MenuChoice>({ message: 'What next?', options: menuOptions(board, update, context.update) })
    }
    catch (error) {
      // Ctrl-C at the menu is how a person leaves; nothing went wrong.
      if (error instanceof CancelledError) {
        return
      }
      throw error
    }
    if (choice === 'exit') {
      return
    }
    if (choice === 'update') {
      const updates = context.update!
      if (!updates.inPlace) {
        updates.tell(update!)
      }
      else if (updates.install()) {
        // This process is still the old kanbo: nothing more should run on it.
        console.log(`Updated to ${update!.latest} — start kanbo again to use it.`)
        return
      }
      told = true
      continue
    }

    try {
      await act(context, choice, board)
    }
    catch (error) {
      // A question inside an item cancelled, or its command failed: say so,
      // and the menu is back.
      // Commander has already said what was wrong with the words it was given.
      if (!(error instanceof CancelledError) && !(error instanceof CommanderError)) {
        console.error(paintFailure(describeFailure(error)))
      }
    }
  }
}

function menuOptions(board: HomeBoard, update: AvailableUpdate | null, updates: HomeUpdate | undefined): { value: MenuChoice, label: string }[] {
  const item = (value: MenuChoice, text: string, command: string): { value: MenuChoice, label: string } =>
    ({ value, label: `${text} — kanbo ${command}` })
  return [
    ...(board.waiting.length > 0 ? [item('review', `Review the cards waiting for you (${board.waiting.length})`, 'approve · kanbo return')] : []),
    item('board', 'Show the board here', MENU_COMMANDS.board.join(' ')),
    item('serve', 'Open the board in your browser', 'serve'),
    item('card', 'Add a card', 'card create'),
    item('connect', 'Connect an agent', 'connect'),
    item('instructions', 'Get the agent instructions', 'instructions'),
    item('columns', 'Change columns', MENU_COMMANDS.columns.join(' ')),
    item('doctor', 'Check the setup', 'doctor'),
    // On Windows the item says how to update after closing kanbo, which cannot replace itself while running;
    // a project's install or npx is told its own command, and nothing is installed.
    ...(update && updates ? [{ value: 'update' as const, label: `${updates.inPlace ? 'Update kanbo' : 'How to update kanbo'} to ${update.latest} — ${updates.command}` }] : []),
    { value: 'exit', label: 'Exit' },
  ]
}

/** What the items that are a command of their own run. */
const MENU_COMMANDS = {
  board: ['board'],
  columns: ['columns'],
} as const satisfies Record<'board' | 'columns', readonly string[]>

async function act(context: BareKanboContext, choice: Exclude<MenuChoice, 'exit' | 'update'>, board: HomeBoard): Promise<void> {
  switch (choice) {
    case 'review':
      await review(context.ui, board.waiting)
      return
    case 'board':
    case 'columns':
      await runCommand(context, [...MENU_COMMANDS[choice]])
      return
    case 'card':
      await addCard(context)
      return
    case 'serve':
      await serveUntilStopped(context)
      return
    default:
      await runCommand(context, [choice])
  }
}

/** Run `kanbo <args>` in this process, as if it had been typed. */
async function runCommand(context: BareKanboContext, args: string[]): Promise<void> {
  await context.createProgram().parseAsync(args, { from: 'user' })
}

/**
 * `kanbo serve` in the foreground: the board page stays up until Ctrl-C, then
 * the server and the board are closed and the menu is back — one server at a
 * time, and nothing left running when the person picks Exit.
 */
async function serveUntilStopped(context: BareKanboContext): Promise<void> {
  const { start, waitForStop } = context.boardPage ?? SERVE_FROM_MENU
  const running = await start()
  try {
    say(context.ui, `Board open at ${running.link} — press Ctrl-C to stop and return to the menu`)
    await waitForStop()
  }
  finally {
    await running.close()
  }
}

/** A card from one line of description, into To Do — `kanbo card create`. */
async function addCard(context: BareKanboContext): Promise<void> {
  const description = (await context.ui.text({
    message: 'What is the card about? (Enter on an empty line to go back)',
    placeholder: 'e.g. Add a README',
  })).trim()
  if (!description) {
    return
  }
  await runCommand(context, ['card', 'create', '--description', description, '--column', READY_COLUMN_SLUG])
}

type Decision = 'approve' | 'return' | 'skip' | 'stop'

/**
 * The cards waiting for a person, one at a time: approve it, send it back
 * with a comment the next agent reads first, skip it, or stop — through the
 * same board operations as `kanbo approve` and `kanbo return`.
 */
async function review(ui: Ui, cards: CardView[]): Promise<void> {
  const approver = requireHumanActor('approve', 'kanbo')
  const returner = requireHumanActor('return', 'kanbo')
  const session = await openBoardSession({}, 'write')
  try {
    for (const card of cards) {
      const comments = await session.store.comments.listByIssue(card.id)
      const last = comments.at(-1)
      say(ui, [
        '',
        `${card.id}  ${card.column ?? '—'}`,
        cardDisplayTitle(card),
        ...(card.statusLine ? [`Status: ${card.statusLine}`] : []),
        ...(last ? [`Last comment: ${firstLine(last.content)}`] : []),
      ].join('\n'))

      const decision = await ui.select<Decision>({
        message: `What about ${card.id}?`,
        options: [
          { value: 'approve', label: 'Approve' },
          { value: 'return', label: 'Send back with a comment' },
          { value: 'skip', label: 'Skip' },
          { value: 'stop', label: 'Stop reviewing' },
        ],
      })
      if (decision === 'stop') {
        return
      }
      if (decision === 'approve') {
        await session.ops.approve(card.id, {}, approver)
        say(ui, `Approved ${card.id}.`)
      }
      if (decision === 'return') {
        const comment = await ui.text({
          message: 'What should change? (the agent reads this first)',
          validate: value => (value?.trim() ? undefined : 'Say what should change, so the agent knows.'),
        })
        const { card: returned } = await session.ops.returnCard(card.id, { comment: comment.trim() }, returner)
        const column = (await session.ops.listColumns(session.workspace.id)).find(candidate => candidate.id === returned.statusId)
        say(ui, `Sent ${card.id} back to ${column?.name ?? '—'}.`)
      }
    }
  }
  finally {
    await session.close()
  }
}

async function readHomeBoard(target: BoardTarget): Promise<HomeBoard> {
  const session = await openBoardSession({}, 'read')
  try {
    const workspaceId = session.workspace.id
    const [columns, rows] = await Promise.all([
      session.ops.listColumns(workspaceId),
      session.store.issues.listInBoardOrder(workspaceId),
    ])
    const waitingRows = rows.filter(row => row.waitingFor === 'human')
    const runs = await session.ops.readBoardProjectionForIssues(waitingRows.map(row => row.id))
    return {
      header: describeHeader(session.workspace, target),
      columns: columns.map(column => ({
        name: column.name,
        category: column.category,
        count: rows.filter(row => row.statusId === column.id).length,
      })),
      waiting: waitingRows.map((row, index) => projectCard(row, columns, runs[index]!)),
    }
  }
  finally {
    await session.close()
  }
}

/** `kanbo · weather-station (WST) · .kanbo/board.db` */
function describeHeader(workspace: BoardWorkspaceIdentity, target: BoardTarget): string {
  // A board file's workspace has no name but its key; the folder it is named after says more.
  const name = workspace.name && workspace.name !== workspace.identifier ? workspace.name : workspace.id
  return `kanbo · ${name} (${readIssuePrefix(workspace)}) · ${describeLocation(target)}`
}

/** Where the board is, as short as still says which: a path from here, or the Postgres host. */
function describeLocation(target: BoardTarget): string {
  if (target.kind === 'postgres') {
    try {
      return `Postgres ${new URL(target.url).host}`
    }
    catch {
      return 'Postgres'
    }
  }
  const fromHere = relative(process.cwd(), target.path)
  if (fromHere && !fromHere.startsWith('..') && !isAbsolute(fromHere)) {
    return fromHere.replaceAll('\\', '/')
  }
  return tildify(target.path)
}

/** The header and the lines under it: columns, what waits, the agents. */
function describeBoard(board: HomeBoard): string[] {
  const waiting = board.waiting.length
  const whom = isAgentShell() ? 'a person' : 'you'
  return [
    board.header,
    board.columns
      .filter(column => column.category !== 'canceled' || column.count > 0)
      .map(column => `${column.name} ${column.count}`)
      .join(' · ') || 'This board has no columns yet',
    ...(waiting > 0 ? [`${waiting} ${waiting === 1 ? 'card' : 'cards'} waiting for ${whom}`] : []),
    describeAgents(),
  ]
}

/**
 * The agents used here and how each is connected, from what `kanbo connect
 * --check` reads: only agents found on this machine or already connected.
 */
function describeAgents(): string {
  const projectDir = findKanboProject(process.cwd())?.root ?? process.cwd()
  const detected = new Set(detectAgents({ projectDir }).filter(found => found.detected).map(found => found.agent))
  const parts = AGENT_IDS.flatMap((agent) => {
    const { row } = checkAgent(agent, null, projectDir, {})
    const instructions = INSTRUCTION_BLOCK_PRESENT.has(row.instructions)
    const mcp = row.mcp === 'ok' || row.mcp === 'yours'
    if (!instructions && !mcp && !detected.has(agent)) {
      return []
    }
    const how = instructions && mcp
      ? '✓ instructions + MCP'
      : instructions ? '✓ instructions only' : mcp ? '✓ MCP only' : '— not connected'
    return [`${AGENTS[agent].label} ${how}`]
  })
  return parts.length > 0 ? `Agents: ${parts.join(' · ')}` : 'Agents: none found — kanbo connect <agent>'
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? ''
  return line.length > 120 ? `${line.slice(0, 119).trimEnd()}…` : line
}

function say(ui: Ui, text: string): void {
  ui.output.write(`${text}\n`)
}

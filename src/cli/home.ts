import { homedir } from 'node:os'
import { isAbsolute, relative } from 'node:path'

import type { Command } from 'commander'
import pc from 'picocolors'

import { cardDisplayTitle } from '../domain/card-display-title'
import { READY_COLUMN_SLUG } from '../domain/column-templates'
import type { BoardWorkspaceIdentity } from '../domain/numbering'
import { readIssuePrefix } from '../domain/numbering'
import type { IssueStatus } from '../sqlite/schema'
import { isAgentShell, requireHumanActor } from './actor'
import { openBoardSession } from './command'
import { checkAgent } from './commands/connect'
import type { BoardTarget } from './db-target'
import { BoardNotFoundError, resolveDbTarget } from './db-target'
import { findKanboProject } from './doctor'
import { describeFailure } from './failure'
import { AGENT_IDS, AGENTS, detectAgents } from './setup/agents'
import type { Ui } from './ui/ui'
import { CancelledError } from './ui/ui'
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
  /** "A newer kanbo is out" — shown under the header when there is one (the update check fills it in). */
  updateNotice: string | null
}

/** What the home screen shows about the board. */
interface HomeBoard {
  header: string
  columns: { name: string, category: IssueStatus['category'], count: number }[]
  waiting: CardView[]
}

/** The `--check` instruction cells that mean a kanbo section is there and readable. */
const INSTRUCTION_BLOCK_PRESENT = new Set(['current', 'outdated', 'legacy', 'edited', 'newer', 'chosen'])

type MenuChoice = 'review' | 'board' | 'serve' | 'card' | 'connect' | 'instructions' | 'columns' | 'doctor' | 'exit'

export async function runBareKanbo(context: BareKanboContext): Promise<void> {
  const target = findBoardTarget()
  if (!context.interactive) {
    console.log(target ? await describePlainly(target) : describeNoBoard())
    return
  }
  if (!target) {
    await runCommand(context, ['init'])
    return
  }
  await runHome(context, target)
}

/** The board this folder works on, or `null` when nothing names one. */
function findBoardTarget(): BoardTarget | null {
  try {
    return resolveDbTarget({ cwd: process.cwd() })
  }
  catch (error) {
    if (error instanceof BoardNotFoundError) {
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

export const NO_BOARD_AGENT_FIRST_LINE = 'This folder has no kanbo board yet. Ask a person to run kanbo here.'

/** No board and nobody to ask: the commands that set one up. */
function describeNoBoard(): string {
  const [first, ...rest] = NO_BOARD_HINT
  return [isAgentShell() ? NO_BOARD_AGENT_FIRST_LINE : first, ...rest].join('\n')
}

/** A board and nobody to ask: the summary, and where to read more. */
async function describePlainly(target: BoardTarget): Promise<string> {
  return [...describeBoard(await readHomeBoard(target), null), 'More: kanbo --help'].join('\n')
}

async function runHome(context: BareKanboContext, target: BoardTarget): Promise<void> {
  const { ui } = context
  while (true) {
    const board = await readHomeBoard(target)
    say(ui, ['', ...describeBoard(board, context.updateNotice)].join('\n'))

    let choice: MenuChoice
    try {
      choice = await ui.select<MenuChoice>({ message: 'What next?', options: menuOptions(context, board) })
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

    try {
      await act(context, choice, board)
    }
    catch (error) {
      // A question inside an item cancelled, or its command failed: say so,
      // and the menu is back.
      if (!(error instanceof CancelledError)) {
        console.error(pc.red(describeFailure(error).message))
      }
    }
  }
}

function menuOptions(context: BareKanboContext, board: HomeBoard): { value: MenuChoice, label: string }[] {
  const item = (value: MenuChoice, text: string, command: string): { value: MenuChoice, label: string } =>
    ({ value, label: `${text} — kanbo ${command}` })
  return [
    ...(board.waiting.length > 0 ? [item('review', `Review the cards waiting for you (${board.waiting.length})`, 'approve · kanbo return')] : []),
    item('board', 'Show the board here', menuCommand(context, 'board').join(' ')),
    item('serve', 'Open the board in your browser', 'serve'),
    item('card', 'Add a card', 'card create'),
    item('connect', 'Connect an agent', 'connect'),
    item('instructions', 'Get the agent instructions', 'instructions'),
    item('columns', 'Change columns', menuCommand(context, 'columns').join(' ')),
    item('doctor', 'Check the setup', 'doctor'),
    { value: 'exit', label: 'Exit' },
  ]
}

/**
 * What a menu item that is a command's own menu runs: `kanbo board` and
 * `kanbo columns` once they run with no further words, and until then the
 * listing that says the same (`card list`, `columns list`).
 */
function menuCommand(context: BareKanboContext, name: 'board' | 'columns'): string[] {
  const fallback = { board: ['card', 'list'], columns: ['columns', 'list'] }[name]
  return runsBare(context.createProgram(), name) ? [name] : fallback
}

/**
 * Does `kanbo <name>` do something on its own? A command without subcommands
 * does; one with subcommands only when it has an action of its own, which
 * commander keeps in a field it does not document.
 */
function runsBare(program: Command, name: string): boolean {
  const command = program.commands.find(candidate => candidate.name() === name)
  if (!command) {
    return false
  }
  return command.commands.length === 0 || (command as unknown as { _actionHandler: unknown })._actionHandler != null
}

async function act(context: BareKanboContext, choice: Exclude<MenuChoice, 'exit'>, board: HomeBoard): Promise<void> {
  switch (choice) {
    case 'review':
      await review(context.ui, board.waiting)
      return
    case 'board':
    case 'columns':
      await runCommand(context, menuCommand(context, choice))
      return
    case 'card':
      await addCard(context)
      return
    default:
      await runCommand(context, [choice])
  }
}

/** Run `kanbo <args>` in this process, as if it had been typed. */
async function runCommand(context: BareKanboContext, args: string[]): Promise<void> {
  await context.createProgram().parseAsync(args, { from: 'user' })
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
  const approver = requireHumanActor('approve')
  const returner = requireHumanActor('return')
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
  const home = homedir()
  return target.path.startsWith(home) ? `~${target.path.slice(home.length).replaceAll('\\', '/')}` : target.path
}

/** The header and the lines under it: columns, what waits, the agents. */
function describeBoard(board: HomeBoard, updateNotice: string | null): string[] {
  const waiting = board.waiting.length
  const whom = isAgentShell() ? 'a person' : 'you'
  return [
    board.header,
    ...(updateNotice ? [updateNotice] : []),
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

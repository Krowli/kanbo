import { existsSync } from 'node:fs'
import { basename, relative, resolve } from 'node:path'

import { DEFAULT_BOARD_FILE_PATH } from '../../default-board-file-path'
import type { ColumnSpec, ColumnTemplateId } from '../../domain/column-templates'
import {
  COLUMN_CATALOGUE,
  COLUMN_TEMPLATE_LABELS,
  COLUMN_TEMPLATES,
  findCatalogueColumn,
  insertOwnColumns,
  ownColumn,
  READY_COLUMN_SLUG,
} from '../../domain/column-templates'
import { maskDatabaseUrl } from '../../domain/database-url'
import { isValidCardKey, suggestCardKey } from '../../domain/key-suggestion'
import { formatIssueId, readIssuePrefix } from '../../domain/numbering'
import { normalizeStatusName } from '../../domain/status-name'
import type { FoundBinding } from '../binding'
import { findBinding } from '../binding'
import type { InitOptions } from '../commands/init'
import { deriveProjectSlug } from '../commands/init'
import { CliError } from '../output'
import type { AgentDetection, AgentId } from '../setup/agents'
import { AGENTS } from '../setup/agents'
import { describeManualOutcome, displayPath, explainItem, itemPath, pendingItems } from '../setup/connect-plan'
import { findGitRoot } from '../setup/git-root'
import type { AppliedInitPlan, InitPlan } from '../setup/init-plan'
import { describeInitPlan } from '../setup/init-plan'
import { INSTRUCTION_BLOCK } from '../setup/instructions'
import { tildify } from '../tildify'
import type { Ui } from '../ui/ui'

/**
 * `kanbo init` at a person's terminal: one question at a time, each answered
 * with the arrow keys or a short line of text.
 *
 * The wizard only asks. Every answer becomes the flag that says the same thing
 * (`--file`, `--database-url`, `--key`, `--columns`, `--connect`,
 * `--first-card`, …), and the plan is worked out by the same `planInit` a
 * command line with those flags goes through — so the two cannot drift apart.
 * A question a flag already answered is not asked, and a project that already
 * has a board is not asked about its board again.
 *
 * Nothing is written here. The last question is "Write these changes?", and
 * the caller applies the plan only after a yes; Ctrl-C at any question throws
 * `CancelledError` and leaves the folder as it was.
 */

export interface InitWizardContext {
  cwd: string
  /** What the command line already said. */
  options: InitOptions
  ui: Ui
  /** Work the answers out into a plan — `planInit`. */
  plan: (projectDir: string, options: InitOptions) => Promise<InitPlan>
  /** Which agents are used on this machine or in this project. */
  detect: (projectDir: string) => AgentDetection[]
  /** Why agents may not be able to start `kanbo mcp` here, if they may not. */
  launchWarning: string | null
  /** What a person is told when their agents will reach a shared board with the owner's connection string. */
  agentUrlWarning: string
}

export interface InitWizardResult {
  projectDir: string
  /** The answers, as the flags that say the same. */
  options: InitOptions
  /** What will be written — the plan the person said yes to. */
  plan: InitPlan
  /** The person chose to paste the instructions into their agent themselves. */
  pasted: boolean
  launchWarning: string | null
}

type BoardHome = 'file' | 'postgres'
type ColumnChoice = ColumnTemplateId | 'custom'
type ConnectChoice = 'yes' | 'not-now' | 'paste'

export async function runInitWizard(context: InitWizardContext): Promise<InitWizardResult> {
  const { ui } = context
  const options: InitOptions = { ...context.options }
  const bound = findBinding(context.cwd)

  say(ui, 'kanbo — set up a board for this project')
  let projectDir: string
  if (bound) {
    projectDir = bound.projectDir
    say(ui, describeExistingBoard(bound, context.cwd))
  }
  else {
    projectDir = await askProjectDir(ui, context.cwd)
    if (!namesBoard(options)) {
      await askBoard(context, projectDir, options)
    }
  }

  let pasted = false
  if (options.connect === undefined && options.instructions === undefined && options.mcp === undefined) {
    const agents = await askAgents(ui, context.detect(projectDir))
    const choice: ConnectChoice = agents.length > 0 ? await askConnect(ui) : 'not-now'
    options.connect = choice === 'yes' ? agents : []
    if (choice === 'paste') {
      pasted = true
      say(ui, `Paste this into your agent's instructions (or run kanbo instructions --copy):\n\n${INSTRUCTION_BLOCK}\n`)
    }
  }

  const plan = await context.plan(projectDir, options)
  if (plan.connect && pendingItems(plan.connect).length > 0) {
    await chooseAgentFiles(ui, plan)
  }

  if (options.firstCard === undefined && canAddCard(plan)) {
    const title = (await ui.text({ message: 'Add a first card? (optional — Enter to skip)', placeholder: 'e.g. Add a README' })).trim()
    if (title) {
      options.firstCard = title
      plan.firstCard = title
    }
  }

  say(ui, describeInitPlan(plan))
  if (!await ui.confirm({ message: 'Write these changes?', initialValue: true })) {
    throw new CliError(1, 'Nothing was written.')
  }
  return { projectDir, options, plan, pasted, launchWarning: context.launchWarning }
}

/** Anything the wizard tells the person, drawn where the prompts are. */
function say(ui: Ui, text: string): void {
  ui.output.write(`${text}\n`)
}

/** Does anything besides the wizard already say which board this is? */
function namesBoard(options: InitOptions): boolean {
  return Boolean(options.db?.trim()
    || options.databaseUrl?.trim()
    || process.env.KANBO_DB_PATH?.trim()
    || process.env.KANBO_DATABASE_URL?.trim())
}

function describeExistingBoard(bound: FoundBinding, cwd: string): string {
  const { binding } = bound
  const where = binding.databaseUrl
    ? `a shared Postgres board (${maskDatabaseUrl(binding.databaseUrl)}), workspace ${binding.workspaceId}`
    : binding.dbPath
      ? binding.dbPath.replaceAll('\\', '/')
      : `the host app's board, workspace ${binding.workspaceId}`
  const prefix = binding.identifier ? readIssuePrefix({ id: binding.workspaceId, identifier: binding.identifier, name: binding.identifier }) : null
  const cards = prefix ? ` (cards ${formatIssueId(prefix, 1)}, ${formatIssueId(prefix, 2)}, …)` : ''
  const folder = bound.projectDir === resolve(cwd) ? 'This project' : `The project at ${bound.projectDir}`
  return `${folder} already has a board: ${where}${cards}. It stays as it is; this sets up your agents.`
}

/** (1) The repository's root, when this folder is somewhere inside one. */
async function askProjectDir(ui: Ui, cwd: string): Promise<string> {
  const here = resolve(cwd)
  const root = findGitRoot(here)
  if (!root || root === here) {
    return here
  }
  return await ui.select({
    message: 'Where should the board be set up?',
    options: [
      { value: root, label: `In the repository root, ${basename(root)} (recommended)` },
      { value: here, label: `Only in this folder, ${relative(root, here).replaceAll('\\', '/')}` },
    ],
  })
}

/** (2)–(4) Where the board lives, what its cards are numbered with, and which columns it starts with. */
async function askBoard(context: InitWizardContext, projectDir: string, options: InitOptions): Promise<void> {
  const { ui } = context
  const home: BoardHome = options.file !== undefined
    ? 'file'
    : await ui.select<BoardHome>({
      message: 'Where should the board live?',
      options: [
        { value: 'file', label: `In this project (file ${DEFAULT_BOARD_FILE_PATH.replaceAll('\\', '/')} — nothing to run or host)` },
        { value: 'postgres', label: 'In a shared Postgres database (for a team; Supabase works)' },
      ],
    })

  if (home === 'postgres') {
    await askPostgres(context, projectDir, options)
  }
  else {
    options.file ??= true
  }

  if (options.identifier === undefined) {
    options.identifier = await askKey(ui, projectDir)
  }

  const filePath = resolve(projectDir, typeof options.file === 'string' && options.file.trim() ? options.file.trim() : DEFAULT_BOARD_FILE_PATH)
  const newBoard = home === 'file' ? !existsSync(filePath) : Boolean(options.migrate)
  if (options.columns === undefined && newBoard) {
    options.columns = await askColumns(ui)
  }
}

async function askPostgres(context: InitWizardContext, projectDir: string, options: InitOptions): Promise<void> {
  const { ui } = context
  say(ui, 'The connection string is stored only in .kanbo/binding.json, which git never sees.')
  options.databaseUrl = (await ui.password({
    message: 'Connection string for the shared board',
    validate: value => (/^postgres(?:ql)?:\/\/\S+$/.test(value?.trim() ?? '')
      ? undefined
      : 'Paste a postgres:// or postgresql:// connection string.'),
  })).trim()
  const slug = deriveProjectSlug(projectDir)
  options.workspace = (await ui.text({
    message: 'Workspace id — the name this project has on the shared board',
    placeholder: slug,
    defaultValue: slug,
  })).trim() || slug
  options.migrate = await ui.confirm({
    message: 'Create the board\'s tables in that database now? (runs kanbo migrate)',
    initialValue: true,
  })
  say(ui, context.agentUrlWarning)
}

/** (3) What card numbers start with. */
async function askKey(ui: Ui, projectDir: string): Promise<string> {
  const suggested = suggestCardKey(basename(projectDir))
  const answer = await ui.text({
    message: 'Card numbers start with',
    placeholder: suggested,
    defaultValue: suggested,
    validate: value => (!value?.trim() || isValidCardKey(value)
      ? undefined
      : 'Use a letter and two letters or digits, like MYA.'),
  })
  const key = (answer.trim() || suggested).toUpperCase()
  say(ui, `→ cards will be ${formatIssueId(key, 1)}, ${formatIssueId(key, 2)}, …`)
  return key
}

/** (4) The columns a new board starts with. */
async function askColumns(ui: Ui): Promise<ColumnSpec[]> {
  const flow = (id: ColumnTemplateId): string => COLUMN_TEMPLATES[id]
    .filter(column => column.category !== 'canceled')
    .map(column => column.name)
    .join(' → ') + (COLUMN_TEMPLATES[id].some(column => column.category === 'canceled') ? ' · Canceled' : '')
  const choice = await ui.select<ColumnChoice>({
    message: 'Which columns should the board start with?',
    options: [
      { value: 'standard', label: `${COLUMN_TEMPLATE_LABELS.standard}: ${flow('standard')}` },
      { value: 'simple', label: `${COLUMN_TEMPLATE_LABELS.simple}: ${flow('simple')}` },
      { value: 'review-qa', label: `${COLUMN_TEMPLATE_LABELS['review-qa']}: … In Review → QA → Done` },
      { value: 'custom', label: 'Custom: pick from a list and add your own' },
    ],
  })
  return choice === 'custom' ? await askCustomColumns(ui) : [...COLUMN_TEMPLATES[choice]]
}

async function askCustomColumns(ui: Ui): Promise<ColumnSpec[]> {
  const picked = new Set(await ui.multiselect<string>({
    message: 'Pick the columns (To Do stays: agents take work from it)',
    options: COLUMN_CATALOGUE.map(column => ({ value: column.name, label: column.name, hint: column.description ?? undefined })),
    initialValues: COLUMN_TEMPLATES.standard.map(column => column.name),
  }))
  const ready = COLUMN_CATALOGUE.find(column => normalizeStatusName(column.name) === READY_COLUMN_SLUG)!
  if (!picked.has(ready.name)) {
    say(ui, 'To Do stays on the board: agents take their work from it.')
    picked.add(ready.name)
  }

  const typed = await ui.text({ message: 'Any columns of your own? Comma-separated, or Enter for none' })
  const taken = new Set([...picked].map(name => normalizeStatusName(name)))
  const own: ColumnSpec[] = []
  for (const name of typed.split(',').map(each => each.trim()).filter(Boolean)) {
    const slug = normalizeStatusName(name)
    if (taken.has(slug)) {
      continue
    }
    taken.add(slug)
    // A ready-made column typed by name is that column, in its own place.
    const known = findCatalogueColumn(name)
    if (known) {
      picked.add(known.name)
      continue
    }
    const description = await ui.text({ message: `One line about "${name}" — when does a card belong there? (agents read this)` })
    own.push(ownColumn(name, description))
  }
  return insertOwnColumns(COLUMN_CATALOGUE.filter(column => picked.has(column.name)), own)
}

/** (5) The agents this person uses; the ones found here are ticked already. */
async function askAgents(ui: Ui, detections: AgentDetection[]): Promise<AgentId[]> {
  return await ui.multiselect<AgentId>({
    message: 'Which coding agents do you use here?',
    options: detections.map(({ agent, detected, evidence }) => ({
      value: agent,
      label: detected && evidence[0] ? `${AGENTS[agent].label} (found ${tildify(evidence[0])})` : AGENTS[agent].label,
    })),
    initialValues: detections.filter(detection => detection.detected).map(detection => detection.agent),
  })
}

/** (6) Whether to connect them now. */
async function askConnect(ui: Ui): Promise<ConnectChoice> {
  return await ui.select<ConnectChoice>({
    message: 'Connect them now?',
    options: [
      { value: 'yes', label: 'Yes — show exactly which files change, then ask' },
      { value: 'not-now', label: 'Not now — set up the board only; no other file is touched (later: kanbo connect)' },
      { value: 'paste', label: 'I\'ll paste the instructions myself (prints them; nothing is written)' },
    ],
  })
}

/** (7) The files connecting changes, each explained; an unticked one is left out of the plan. */
async function chooseAgentFiles(ui: Ui, plan: InitPlan): Promise<void> {
  const connect = plan.connect!
  const pending = pendingItems(connect)
  const keys = pending.map((_, index) => `${index}`)
  const kept = new Set(await ui.multiselect<string>({
    message: 'These files change so your agents know the board. Keep all of them?',
    options: pending.map((item, index) => ({
      value: keys[index]!,
      label: item.kind === 'claude-cli' ? 'Claude Code user settings' : displayPath(connect, itemPath(item)),
      hint: explainItem(item),
    })),
    initialValues: keys,
  }))
  connect.items = connect.items.filter(item => !pending.includes(item) || kept.has(`${pending.indexOf(item)}`))
  if (pendingItems(connect).some(item => item.kind === 'instructions')) {
    say(ui, `The kanbo section your agents get:\n\n${INSTRUCTION_BLOCK}\n`)
  }
}

/** A shared board whose tables were not created here may have none yet, so there is nowhere to put a card. */
function canAddCard(plan: InitPlan): boolean {
  return plan.target.kind !== 'postgres' || plan.migrate
}

/** (9) What was done, and what to do next. */
export function printInitOutro(ui: Ui, result: InitWizardResult, applied: AppliedInitPlan): void {
  const { plan } = result
  const lines: string[] = []
  if (plan.target.kind === 'postgres') {
    const tables = plan.migrate ? 'tables created' : 'tables not created here — run kanbo migrate when they are needed'
    lines.push(`✔ Board: shared Postgres ${maskDatabaseUrl(plan.target.url)}, workspace ${plan.workspace.id} (${tables})`)
  }
  else if (plan.target.owner === 'kanbo') {
    const kept = plan.boardFile?.exists === false ? '' : ' (kept as it is)'
    lines.push(`✔ Board: ${displayPath(plan, plan.target.path).replaceAll('\\', '/')}${kept}`)
  }
  else {
    lines.push(`✔ Board: the host app's board, workspace ${plan.workspace.id}`)
  }
  if (applied.columns.length > 0) {
    lines.push(`✔ Columns: ${applied.columns.join(', ')}`)
  }
  const prefix = readIssuePrefix(plan.workspace)
  lines.push(`✔ Card numbers: ${formatIssueId(prefix, 1)}, ${formatIssueId(prefix, 2)}, …`)

  const connected: AgentId[] = []
  for (const outcome of applied.connect) {
    const who = outcome.agents.map(agent => AGENTS[agent].label).join(' and ')
    const where = displayPath(plan, outcome.path).replaceAll('\\', '/')
    if (outcome.state === 'manual') {
      lines.push(`! ${describeManualOutcome(who, outcome)}`)
      continue
    }
    connected.push(...outcome.agents)
    lines.push(`✔ ${who}: ${where} (${outcome.state === 'ran' ? `ran ${outcome.command}` : outcome.state})`)
  }
  for (const file of applied.files) {
    lines.push(`✔ ${displayPath(plan, file.path).replaceAll('\\', '/')} (${file.state})`)
  }
  for (const note of plan.connect?.notes ?? []) {
    lines.push(`Note: ${note}`)
  }
  if (applied.firstCard) {
    lines.push(`✔ First card: ${applied.firstCard.id} ${applied.firstCard.title}`)
  }
  const anyAgent = connected.length > 0 || applied.files.length > 0
  if (anyAgent && result.launchWarning) {
    lines.push(`! ${result.launchWarning}`)
  }

  lines.push('')
  const first = result.options.connect?.find(agent => connected.includes(agent))
  if (first) {
    lines.push(`Next: start ${AGENTS[first].label} in this folder and say "take the next card from kanbo".`)
  }
  else if (result.pasted) {
    lines.push('Next: paste the instructions into your agent, then say "take the next card from kanbo".')
  }
  else if (!anyAgent) {
    lines.push('Next: connect your agent with kanbo connect <agent>, or paste kanbo instructions --copy into it.')
  }
  lines.push('See the board: kanbo board · in your browser: kanbo serve')
  lines.push('Run kanbo any time to come back here.')
  say(ui, lines.join('\n'))
}

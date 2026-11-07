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
import { findMissingBoardFile } from '../db-target'
import type { InitOptions } from '../commands/init'
import { deriveProjectSlug } from '../commands/init'
import { describeFailure } from '../failure'
import type { AgentDetection, AgentId } from '../setup/agents'
import { AGENTS } from '../setup/agents'
import { describeManualOutcome, describeOutcomeState, displayPath, readMcpState } from '../setup/connect-plan'
import type { ExistingWorkspace } from '../setup/existing-workspace'
import { inspectBoardFile, inspectPostgresWorkspace } from '../setup/existing-workspace'
import { findGitRoot } from '../setup/git-root'
import type { AppliedInitPlan, InitPlan } from '../setup/init-plan'
import { tildify } from '../tildify'
import type { Ui } from '../ui/ui'
import { CancelledError } from '../ui/ui'

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
 * Nothing is written here. The caller applies the plan once the questions are
 * answered; Ctrl-C at any question throws `CancelledError` and leaves the
 * folder as it was.
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
  /** What will be written — the plan the answers make. */
  plan: InitPlan
  /** The agents used here that already reach kanbo through its MCP server, before this run. */
  alreadyConnected: AgentId[]
  launchWarning: string | null
}

type BoardHome = 'file' | 'postgres'
type ColumnChoice = ColumnTemplateId | 'custom'
type ConnectChoice = 'yes' | 'not-now'

export async function runInitWizard(context: InitWizardContext): Promise<InitWizardResult> {
  const { ui } = context
  const options: InitOptions = { ...context.options }
  const bound = findBinding(context.cwd)

  say(ui, 'kanbo — set up a board for this project')
  let projectDir: string
  // Only a project that is bound has a board file to lose; `KANBO_DB_PATH` alone does not make one.
  const missing = bound ? findMissingBoardFile(context.cwd) : null
  if (missing) {
    projectDir = bound?.projectDir ?? await askProjectDir(ui, context.cwd)
    await replaceMissingBoard(ui, missing, projectDir, bound, options)
  }
  else if (bound) {
    projectDir = bound.projectDir
    say(ui, describeExistingBoard(bound, context.cwd))
  }
  else {
    projectDir = await askProjectDir(ui, context.cwd)
    if (namesPostgres(options)) {
      // A connection string came with the command or the environment: the
      // board's home is settled, the workspace and its key are not.
      await askBoard(context, projectDir, options, 'postgres')
    }
    else if (!namesBoard(options)) {
      await askBoard(context, projectDir, options)
    }
  }

  const alreadyConnected: AgentId[] = []
  if (options.connect === undefined) {
    // Asked only when an agent used here still lacks kanbo's MCP server: one registration serves every project.
    const detections = context.detect(projectDir)
    const reaches = (agent: AgentId): boolean => (['project', 'user'] as const).some(scope => readMcpState(agent, scope, projectDir) !== 'missing')
    const detected = detections.filter(detection => detection.detected)
    alreadyConnected.push(...detected.map(detection => detection.agent).filter(reaches))
    if (detected.length > 0 && alreadyConnected.length === detected.length) {
      say(ui, 'Your agents already reach kanbo through its MCP server.')
      options.connect = []
    }
    else {
      const agents = await askAgents(ui, detections, reaches)
      const choice: ConnectChoice = agents.length > 0 ? await askConnect(ui) : 'not-now'
      options.connect = choice === 'yes' ? agents : []
    }
  }

  const plan = await context.plan(projectDir, options)
  return { projectDir, options, plan, alreadyConnected, launchWarning: context.launchWarning }
}

/** Anything the wizard tells the person, drawn where the prompts are. */
function say(ui: Ui, text: string): void {
  ui.output.write(`${text}\n`)
}

/** Does the command line or the environment already name a shared Postgres board? */
function namesPostgres(options: InitOptions): boolean {
  return Boolean(options.databaseUrl?.trim() || (!options.db?.trim() && options.file === undefined && process.env.KANBO_DATABASE_URL?.trim()))
}

/**
 * Does anything besides the wizard already say which board this is? `--db` or
 * a connection string does. `KANBO_DB_PATH` does not: it names an app's own
 * database for the commands the app starts, and where a new board goes is
 * still the person's question (see `namesNoBoard` in `commands/init.ts`).
 */
function namesBoard(options: InitOptions): boolean {
  return Boolean(options.db?.trim()
    || options.databaseUrl?.trim()
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

/**
 * The board file this project is bound to is gone.
 * The one way on from here is a new, empty board — where the old one was when
 * the project is bound to it — or nothing at all. `--file` already said "a new
 * one"; the columns are asked, and the card key stays the one it was bound to.
 */
async function replaceMissingBoard(ui: Ui, missing: string, projectDir: string, bound: FoundBinding | null, options: InitOptions): Promise<void> {
  say(ui, `This project's board file is missing: ${missing}.`)
  if (options.file === undefined) {
    const boundPath = bound?.binding.dbPath?.trim()
    const where = boundPath ? resolve(bound!.projectDir, boundPath) : resolve(projectDir, DEFAULT_BOARD_FILE_PATH)
    const choice = await ui.select<'create' | 'cancel'>({
      message: 'What now?',
      options: [
        { value: 'create', label: `Create a new empty board at ${shortPath(where, projectDir)} (the old cards are gone)` },
        { value: 'cancel', label: 'Cancel' },
      ],
    })
    if (choice === 'cancel') {
      throw new CancelledError()
    }
    options.file = true
  }
  if (options.columns === undefined) {
    options.columns = await askColumns(ui)
  }
}

/** A path inside the project from its root, any other one from home when it can be. */
function shortPath(path: string, projectDir: string): string {
  const inside = relative(projectDir, path)
  return inside && !inside.startsWith('..') && !/^[a-z]:/i.test(inside) ? inside.replaceAll('\\', '/') : tildify(path)
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
async function askBoard(context: InitWizardContext, projectDir: string, options: InitOptions, given?: BoardHome): Promise<void> {
  const { ui } = context
  const home: BoardHome = given ?? (options.file !== undefined
    ? 'file'
    : await ui.select<BoardHome>({
      message: 'Where should the board live?',
      options: [
        { value: 'file', label: `In this project (file ${DEFAULT_BOARD_FILE_PATH.replaceAll('\\', '/')} — nothing to run or host)` },
        { value: 'postgres', label: 'In a shared Postgres database (for a team; Supabase works)' },
      ],
    }))

  let existing: ExistingWorkspace | null
  if (home === 'postgres') {
    existing = await askPostgres(context, projectDir, options)
  }
  else {
    options.file ??= true
    const filePath = resolve(projectDir, typeof options.file === 'string' && options.file.trim() ? options.file.trim() : DEFAULT_BOARD_FILE_PATH)
    existing = await inspectBoardFile(filePath, options.workspace?.trim() || deriveProjectSlug(projectDir))
    // A file that is there is a board already: its columns stay as they are.
    existing = existing ?? (existsSync(filePath) ? { key: null, hasColumns: true, columnNames: [] } : null)
  }

  if (options.identifier === undefined) {
    if (existing?.key) {
      options.identifier = existing.key
      say(ui, `This board already numbers its cards ${formatIssueId(existing.key, 1)}, … — new cards go on from there.`)
    }
    else {
      options.identifier = await askKey(ui, projectDir)
    }
  }

  const newBoard = home === 'file' ? existing === null : Boolean(options.migrate)
  if (existing?.hasColumns && home === 'postgres') {
    say(ui, 'This workspace already has its columns.')
  }
  else if (options.columns === undefined && newBoard) {
    options.columns = await askColumns(ui)
  }
}

/**
 * The shared board: its connection string (unless the command line or the
 * environment gave one), the workspace id, and whether to create its tables.
 * Returns what the board already holds for that workspace, when its tables
 * are there — a workspace a teammate set up is joined, not set up again.
 */
async function askPostgres(context: InitWizardContext, projectDir: string, options: InitOptions): Promise<ExistingWorkspace | null> {
  const { ui } = context
  say(ui, 'The connection string is stored only in .kanbo/binding.json, which git never sees.')
  if (!options.databaseUrl?.trim() && !process.env.KANBO_DATABASE_URL?.trim()) {
    options.databaseUrl = (await ui.password({
      message: 'Connection string for the shared board',
      validate: value => (/^postgres(?:ql)?:\/\/\S+$/.test(value?.trim() ?? '')
        ? undefined
        : 'Paste a postgres:// or postgresql:// connection string.'),
    })).trim()
  }
  const url = options.databaseUrl?.trim() || process.env.KANBO_DATABASE_URL!.trim()
  if (options.workspace === undefined) {
    const slug = deriveProjectSlug(projectDir)
    options.workspace = (await ui.text({
      message: 'Workspace id — the name this project has on the shared board',
      placeholder: slug,
      defaultValue: slug,
    })).trim() || slug
  }
  const existing = await inspectPostgresWorkspace(url, options.workspace).catch((error: unknown) => {
    // Not reachable from here right now: the questions below still set the
    // project up, and the board is reached when it is used.
    say(ui, `Couldn't look into the shared board (${describeFailure(error).message.split('\n')[0]}) — asking instead.`)
    return null
  })
  if (existing) {
    // The tables are there; migrating brings them up to this build and changes nothing else.
    options.migrate ??= true
  }
  else {
    options.migrate ??= await ui.confirm({
      message: 'Create the board\'s tables in that database now? (runs kanbo migrate)',
      initialValue: true,
    })
  }
  say(ui, context.agentUrlWarning)
  return existing
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

/** (5) The agents this person uses; the ones found here that kanbo does not reach yet are ticked already. */
async function askAgents(ui: Ui, detections: AgentDetection[], reaches: (agent: AgentId) => boolean): Promise<AgentId[]> {
  return await ui.multiselect<AgentId>({
    message: 'Which coding agents do you use here?',
    options: detections.map(({ agent, detected, evidence }) => ({
      value: agent,
      label: detected && evidence[0] ? `${AGENTS[agent].label} (found ${tildify(evidence[0])})` : AGENTS[agent].label,
    })),
    initialValues: detections.filter(detection => detection.detected && !reaches(detection.agent)).map(detection => detection.agent),
  })
}

/** (6) Whether to connect them now. */
async function askConnect(ui: Ui): Promise<ConnectChoice> {
  return await ui.select<ConnectChoice>({
    message: 'Connect them now?',
    options: [
      { value: 'yes', label: 'Yes — register kanbo\'s MCP server for them, for every project' },
      { value: 'not-now', label: 'Not now — set up the board only (later: kanbo connect)' },
    ],
  })
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
    lines.push(`✔ ${who}: ${where} (${describeOutcomeState(outcome)})`)
  }
  for (const note of plan.connect?.notes ?? []) {
    lines.push(`Note: ${note}`)
  }
  if (applied.firstCard) {
    lines.push(`✔ First card: ${applied.firstCard.id} ${applied.firstCard.title}`)
  }
  if (connected.length > 0 && result.launchWarning) {
    lines.push(`! ${result.launchWarning}`)
  }

  lines.push('')
  const first = [...connected, ...result.alreadyConnected][0]
  if (first) {
    lines.push(`Next: start ${AGENTS[first].label} in this folder and say "take the next card from kanbo".`)
  }
  else {
    lines.push('Next: connect your agent once: kanbo connect claude (or codex, cursor, gemini).')
  }
  lines.push('See the board: kanbo board · in your browser: kanbo serve')
  lines.push('Run kanbo any time to come back here.')
  say(ui, lines.join('\n'))
}

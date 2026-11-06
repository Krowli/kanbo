import type { Command } from 'commander'

import { findKanboProject } from '../doctor'
import type { CliResult } from '../output'
import { CliError, printResult } from '../output'
import type { AgentId } from '../setup/agents'
import { AGENT_IDS, AGENTS, defaultMcpScope, detectAgents, parseAgentId } from '../setup/agents'
import { confirmPlan } from '../setup/confirm'
import type { ConnectOutcome, ConnectPlan, ConnectRequest, McpState } from '../setup/connect-plan'
import {
  applyConnectPlan,
  describeConnectPlan,
  describeManualOutcome,
  displayPath,
  explainItem,
  itemPath,
  ownMcpEntryNote,
  pendingItems,
  planConnect,
  planDisconnect,
  readOldSectionPaths,
  readMcpEntry,
  readMcpState,
} from '../setup/connect-plan'
import { canStartMcpEntry } from '../setup/mcp-config'
import type { McpScope } from '../setup/mcp-launch'
import { canPrompt } from '../ui/environment'
import { getUi } from '../ui/ui'

/**
 * `kanbo connect` — tell the agent tools a person uses about kanbo: the board's
 * MCP server, registered in each one's configuration (the person's own by
 * default, so it serves every project). It also takes out the kanbo section
 * older versions wrote into the agents' instruction files. `--check` shows what
 * is connected and `--remove` takes kanbo out again.
 *
 * Every change is worked out first (`setup/connect-plan.ts`) and shown; nothing
 * is written until the person says yes, or said `--yes`.
 */
export interface ConnectOptions {
  project?: boolean
  global?: boolean
  check?: boolean
  remove?: boolean
  dryRun?: boolean
  yes?: boolean
  /** `--json` alone: the whole result as JSON; `--json a,b`: only those fields. */
  json?: string | boolean
}

/** Where each agent's parts go, before `--project`/`--global` say otherwise. */
export type ScopeFlag = 'project' | 'user' | null

const AGENT_LIST = `${AGENT_IDS.join(', ')} (or all)`

export function registerConnectCommand(program: Command): void {
  program
    .command('connect')
    .alias('setup')
    .argument('[agents...]', `the agents to connect: ${AGENT_LIST}`)
    .description('Connect your coding agents to the board: its MCP server, for every project (--project: this project only)')
    .option('--project', 'write into this project\'s files only')
    .option('--global', 'write into your own files, for every project (the default)')
    .option('--check', 'show what is connected; exits 1 when a named agent is not')
    .option('--remove', 'disconnect: take kanbo out of their MCP settings and instruction files')
    .option('--dry-run', 'show what would change, and change nothing')
    .option('--yes', 'make the changes without asking')
    .option('--json [fields]', 'print the result as JSON; name comma-separated fields to print only those')
    .action(async (names: string[], options: ConnectOptions) => {
      await connect(names, options)
    })
}

async function connect(names: string[], options: ConnectOptions): Promise<void> {
  if (options.project && options.global) {
    throw new CliError(1, 'Pick one: --project for this project\'s files, or --global for your own.')
  }
  const scope: ScopeFlag = options.project ? 'project' : options.global ? 'user' : null
  const projectDir = findKanboProject(process.cwd())?.root ?? process.cwd()
  const named = parseAgents(names)

  if (options.check) {
    runCheck(named ?? [...AGENT_IDS], Boolean(named), scope, projectDir, options)
    return
  }

  // `--remove` without agents takes kanbo out of every one of them.
  if (options.remove && named === null) {
    await disconnect([...AGENT_IDS], scope, projectDir, options)
    return
  }

  const interactive = named === null
  if (interactive && (!canPrompt() || options.yes)) {
    throw new CliError(1, `Name the agents to connect: kanbo connect <agents...>, from ${AGENT_LIST}. `
      + 'For example: kanbo connect claude --yes')
  }
  const agents = named ?? await askAgents(projectDir)
  if (agents.length === 0) {
    throw new CliError(1, 'Nothing was changed: no agent picked.')
  }

  if (options.remove) {
    await disconnect(agents, scope, projectDir, options)
    return
  }

  const requests = agents.map(agent => request(agent, scope))
  const plan = await planConnect(requests, { projectDir, yes: options.yes || options.dryRun })
  const machine = options.json !== undefined
  if (options.dryRun) {
    print(machine, describeConnectPlan(plan, 'kanbo connect would:'))
    printResult(describeOutcomes('connect', agents, [], plan, true), outputOptions(options))
    return
  }
  const previewed = pendingItems(plan).length > 0
  if (previewed) {
    if (interactive) {
      await chooseAndConfirm(plan)
    }
    else if (!await confirmPlan({
      preview: describeConnectPlan(plan, 'kanbo connect will:'),
      question: 'Make these changes?',
      yes: options.yes,
      machineOutput: machine,
      command: 'kanbo connect',
    })) {
      throw new CliError(1, 'Nothing was changed.')
    }
  }
  printResult(describeOutcomes('connect', agents, applyConnectPlan(plan), plan, false, previewed), outputOptions(options))
}

/**
 * What one agent gets: its MCP server where the scope says (the person's own
 * configuration by default), and the old kanbo section taken out of its
 * instruction file in the same scope — in both files when none is named.
 */
function request(agent: AgentId, scope: ScopeFlag): ConnectRequest {
  return { agent, instructions: scope ?? 'both', mcp: scope ?? defaultMcpScope() }
}

async function disconnect(agents: AgentId[], scope: ScopeFlag, projectDir: string, options: ConnectOptions): Promise<void> {
  const scopes: McpScope[] = scope ? [scope] : ['project', 'user']
  const requests = scopes.flatMap(each => agents.map(agent => ({
    agent,
    instructions: each,
    mcp: each,
  })))
  const plan = await planDisconnect(requests, { projectDir, yes: options.yes, prompt: !options.dryRun })
  const machine = options.json !== undefined
  if (options.dryRun) {
    print(machine, describeConnectPlan(plan, 'kanbo connect --remove would:', true))
    printResult(describeOutcomes('remove', agents, [], plan, true), outputOptions(options))
    return
  }
  const previewed = pendingItems(plan).length > 0
  if (previewed && !await confirmPlan({
    preview: describeConnectPlan(plan, 'kanbo connect --remove will:', true),
    question: 'Remove these?',
    yes: options.yes,
    machineOutput: machine,
    command: 'kanbo connect --remove',
  })) {
    throw new CliError(1, 'Nothing was changed.')
  }
  printResult(describeOutcomes('remove', agents, applyConnectPlan(plan), plan, false, previewed), outputOptions(options))
}

/** Which agents, asked at a terminal: the ones found on this machine or in this project already ticked. */
async function askAgents(projectDir: string): Promise<AgentId[]> {
  const detections = detectAgents({ projectDir })
  return await getUi().multiselect<AgentId>({
    message: 'Which agents do you use?',
    options: detections.map(({ agent, detected }) => ({
      value: agent,
      label: AGENTS[agent].label,
      ...(detected ? { hint: 'found here' } : {}),
    })),
    initialValues: detections.filter(detection => detection.detected).map(detection => detection.agent),
  })
}

/**
 * Let the person untick any change, then show what is left and ask once.
 * Unticked changes are dropped from the plan.
 */
async function chooseAndConfirm(plan: ConnectPlan): Promise<void> {
  const ui = getUi()
  const pending = pendingItems(plan)
  const keys = pending.map((_, index) => `${index}`)
  const kept = new Set(await ui.multiselect<string>({
    message: 'Which of these should kanbo change?',
    options: pending.map((item, index) => ({
      value: keys[index]!,
      label: item.kind === 'claude-cli' ? 'Claude Code user settings' : displayPath(plan, itemPath(item)),
      hint: explainItem(item),
    })),
    initialValues: keys,
  }))
  plan.items = plan.items.filter(item => !pending.includes(item) || kept.has(`${pending.indexOf(item)}`))
  if (pendingItems(plan).length === 0) {
    throw new CliError(1, 'Nothing was changed.')
  }
  console.log(describeConnectPlan(plan, 'kanbo connect will:'))
  if (!await ui.confirm({ message: 'Make these changes?', initialValue: true })) {
    throw new CliError(1, 'Nothing was changed.')
  }
}

/**
 * What was done. The plan's notes end it only when no preview said them
 * already — a plan with changes to make was printed, notes and all, before
 * anything was done.
 */
function describeOutcomes(action: 'connect' | 'remove', agents: AgentId[], outcomes: ConnectOutcome[], plan: ConnectPlan, dryRun: boolean, notesShown = false): CliResult {
  const lines: string[] = []
  if (dryRun) {
    lines.push('Dry run: nothing was changed.')
  }
  for (const outcome of outcomes.filter(each => action === 'connect' || each.state !== 'unchanged')) {
    const who = outcome.agents.map(agent => AGENTS[agent].label).join(', ')
    const where = displayPath(plan, outcome.path)
    if (outcome.state === 'manual') {
      lines.push(describeManualOutcome(who, outcome))
    }
    else {
      const state = outcome.state === 'written' && action === 'remove' ? 'removed' : outcome.state
      lines.push(`${who}: ${where} (${state === 'ran' ? `ran ${outcome.command}` : state})`)
    }
  }
  if (!dryRun && !notesShown) {
    lines.push(...plan.notes.map(note => `Note: ${note}`))
  }
  if (action === 'connect' && !dryRun) {
    lines.push('Check it with kanbo connect --check.')
  }
  return {
    value: {
      action,
      dryRun,
      agents,
      changes: dryRun
        ? pendingItems(plan).map(item => ({ kind: item.kind, scope: item.scope, path: itemPath(item) }))
        : outcomes,
      notes: plan.notes,
    },
    text: lines.join('\n'),
    fields: ['action', 'dryRun', 'agents', 'changes', 'notes'],
  }
}

/** One row of `--check`. */
export interface CheckRow {
  agent: AgentId
  mcp: string
  scope: string
  connected: boolean
  /** The files that still carry a kanbo section from an older version. */
  oldSections: string[]
}

function runCheck(agents: AgentId[], named: boolean, flag: ScopeFlag, projectDir: string, options: ConnectOptions): void {
  const checked = agents.map(agent => checkAgent(agent, flag, projectDir))
  const rows = checked.map(({ row }) => row)
  const text = [
    ['agent', 'MCP', 'scope'],
    ...rows.map(row => [row.agent, row.mcp, row.scope]),
  ]
  const widths = text[0]!.map((_, column) => Math.max(...text.map(line => line[column]!.length)))
  const notes = checked.flatMap(({ notes }) => notes)
  const oldSections = [...new Set(rows.flatMap(row => row.oldSections))]
  printResult({
    value: rows,
    text: [
      ...text.map(line => line.map((cell, column) => cell.padEnd(widths[column]!)).join('  ').trimEnd()),
      ...oldSections.map(path => `old kanbo section in ${path} — kanbo connect removes it`),
      ...notes.map(note => `Note: ${note}`),
    ].join('\n'),
  }, outputOptions(options))
  const missing = rows.filter(row => !row.connected)
  if (named && missing.length > 0) {
    throw new CliError(1, `Not connected: ${missing.map(row => row.agent).join(', ')}. Run kanbo connect ${missing.map(row => row.agent).join(' ')}.`)
  }
}

/**
 * Where an agent stands: its MCP entry, looked for in the scope named — or,
 * when none was, in the project first and then the person's own files.
 * Connected means the entry is there and still starts. An MCP entry of the
 * person's own is theirs: it is reported, left as it is, and counts as
 * connected when it can start. Files that still carry a kanbo section from an
 * older version are listed, for `kanbo connect` to take out.
 */
export function checkAgent(agent: AgentId, flag: ScopeFlag, projectDir: string): { row: CheckRow, notes: string[] } {
  const scopes: McpScope[] = flag ? [flag] : ['project', 'user']
  const notes: string[] = []

  const states = scopes.map(scope => ({ scope, state: readMcpState(agent, scope, projectDir) }))
  const present = states.find(({ state }) => state === 'ok')
    ?? states.find(({ state }) => state === 'own')
    ?? states.find(({ state }) => state === 'stale')
  let mcp = present ? MCP_CELLS[present.state as Exclude<McpState, 'missing'>] : 'missing'
  if (present?.state === 'own') {
    const target = AGENTS[agent].mcpTarget(present.scope, projectDir)
    const startable = canStartMcpEntry(readMcpEntry(target)!)
    mcp = startable ? 'yours' : 'yours, won\'t start'
    notes.push(`${ownMcpEntryNote(AGENTS[agent].label, target.path)}${startable ? '' : ' It can\'t start here: its command is not found.'}`)
  }

  return {
    row: {
      agent,
      mcp,
      scope: present ? present.scope : (flag ?? defaultMcpScope()),
      connected: mcp === 'ok' || mcp === 'yours',
      oldSections: scopes.flatMap(scope => readOldSectionPaths(agent, scope, projectDir)),
    },
    notes,
  }
}

const MCP_CELLS: Record<Exclude<McpState, 'missing'>, string> = { ok: 'ok', stale: 'stale path', own: 'yours' }

/** The named agents, `all` for every one; `null` when none was named. */
function parseAgents(names: string[]): AgentId[] | null {
  if (names.length === 0) {
    return null
  }
  const agents = names.flatMap(name => name.split(',')).map(name => name.trim()).filter(Boolean).flatMap((name) => {
    if (name.toLowerCase() === 'all') {
      return [...AGENT_IDS]
    }
    const agent = parseAgentId(name)
    if (!agent) {
      throw new CliError(1, `Unknown agent "${name}". Use one or more of ${AGENT_LIST}.`)
    }
    return [agent]
  })
  return [...new Set(agents)]
}

function outputOptions(options: ConnectOptions): { json?: string, format?: string } {
  if (options.json === true) {
    return { format: 'pretty' }
  }
  return typeof options.json === 'string' ? { json: options.json } : {}
}

/** Anything besides the result goes to stderr when the result is machine output. */
function print(machine: boolean, text: string): void {
  (machine ? console.error : console.log)(text)
}

import { relative } from 'node:path'

import { canPrompt } from '../ui/environment'
import { getUi } from '../ui/ui'
import type { AgentId, McpTarget } from './agents'
import { AGENT_IDS, AGENTS } from './agents'
import type { FileChange } from './file-change'
import { applyFileChange } from './file-change'
import type { InstructionBlockState } from './instructions'
import {
  GLOBAL_INSTRUCTION_BLOCK,
  INSTRUCTION_BLOCK,
  planInstructionBlockAsking,
  planInstructionBlockRemovalAsking,
  readInstructionBlockState,
} from './instructions'
import { isNpxScript, NOT_INSTALLED_FIX } from './launch-warning'
import type { McpEntry } from './mcp-config'
import {
  CLAUDE_USER_REMOVE,
  claudeUserAddArgv,
  displayCommand,
  isOwnMcpEntry,
  isStaleMcpEntry,
  planCodexMcpServer,
  planCodexMcpServerRemoval,
  planJsonMcpServer,
  planJsonMcpServerRemoval,
  readCodexMcpEntry,
  readJsonMcpEntry,
  runClaudeMcp,
} from './mcp-config'
import type { McpScope } from './mcp-launch'
import { mcpLaunchSpec } from './mcp-launch'

/**
 * What connecting agents to kanbo — or disconnecting them — does to files,
 * worked out in full before anything is written.
 *
 * `kanbo connect` builds one of these from the agents and scopes it was given,
 * `kanbo init --instructions/--mcp` and `kanbo init --global` build theirs the
 * same way, and all of them show it, ask, and apply it here. Each item is one
 * file (or one `claude mcp` command) with what changes in it; an item whose
 * file already says it has `next: null` and is reported `unchanged`.
 */

/** Codex reads a project's `.codex/config.toml` only once the person has marked the project trusted. */
export const CODEX_PROJECT_NOTE = 'Codex reads .codex/config.toml only in a project you have marked as trusted; '
  + 'kanbo connect codex without --project registers it in your own ~/.codex/config.toml instead.'

/**
 * Why a registration naming this kanbo by full path is not written: a kanbo
 * run from npx lives in npm's cache only while that one command runs.
 */
export const NPX_USER_REGISTRATION_REFUSAL = `Install kanbo first so agents can start it: ${NOT_INSTALLED_FIX}`

/** What the person is told about a `kanbo` MCP entry of their own, which kanbo does not change. */
export function ownMcpEntryNote(label: string, path: string): string {
  return `${label}: ${path} has your own kanbo entry — left as is.`
}

/** What one agent should get, and where: `null` leaves that part alone. */
export interface AgentRequest {
  agent: AgentId
  instructions: McpScope | null
  mcp: McpScope | null
}

export type ConnectItem =
  | {
    kind: 'instructions'
    /** Every agent that reads this file — Codex and Cursor share a project's `AGENTS.md`. */
    agents: AgentId[]
    scope: McpScope
    change: FileChange
  }
  | {
    kind: 'mcp'
    agent: AgentId
    scope: McpScope
    change: FileChange
    /** The entry there was kanbo's own and no longer started; it is rewritten. */
    stale?: boolean
  }
  | {
    /** Claude Code's user registration, which only `claude mcp` changes; no commands means nothing to do. */
    kind: 'claude-cli'
    agent: 'claude'
    scope: 'user'
    path: string
    argvs: string[][]
  }

export interface ConnectPlan {
  projectDir: string
  items: ConnectItem[]
  /** Things the person is told that are not changes: a block of theirs kept, a scope with no file. */
  notes: string[]
}

export interface ConnectOutcome {
  kind: ConnectItem['kind']
  agents: AgentId[]
  scope: McpScope
  path: string
  /** `ran`/`manual`: a `claude mcp` command run, or handed to the person. */
  state: 'written' | 'unchanged' | 'ran' | 'manual'
  /** The command run, or — when `manual` — the ones left to run, one per line. */
  command?: string
  reason?: string
  /** `manual` after `claude mcp remove` ran and the `add` after it failed: the old entry is gone. */
  removed?: boolean
}

/**
 * The plan that connects these agents. Asks only one question, and only at a
 * terminal: whether to replace an instruction block the person changed.
 */
export async function planConnect(
  requests: AgentRequest[],
  context: { projectDir: string, yes?: boolean, platform?: NodeJS.Platform },
): Promise<ConnectPlan> {
  const plan: ConnectPlan = { projectDir: context.projectDir, items: [], notes: [] }
  const planned = new Set<string>()

  for (const { agent, instructions: scope } of requests) {
    if (scope === null) {
      continue
    }
    const path = AGENTS[agent].instructionPath(scope, context.projectDir)
    if (path === null) {
      plan.notes.push(AGENTS[agent].noInstructionFile ?? `${AGENTS[agent].label} has no instruction file for this scope.`)
      continue
    }
    const existing = plan.items.find(item => item.kind === 'instructions' && item.change.path === path)
    if (existing?.kind === 'instructions') {
      existing.agents.push(agent)
      continue
    }
    const block = scope === 'project' ? INSTRUCTION_BLOCK : GLOBAL_INSTRUCTION_BLOCK
    const asked = await planInstructionBlockAsking(path, block, { yes: context.yes, label: displayPath(plan, path) })
    if (asked.note) {
      plan.notes.push(asked.note)
    }
    plan.items.push({ kind: 'instructions', agents: [agent], scope, change: asked.change })
  }

  for (const { agent, mcp: scope } of requests) {
    if (scope === null) {
      continue
    }
    const target = AGENTS[agent].mcpTarget(scope, context.projectDir)
    if (planned.has(target.path)) {
      continue
    }
    planned.add(target.path)
    const launch = mcpLaunchSpec({ scope, platform: context.platform })
    const entry = readMcpEntry(target)
    if (entry !== undefined && !isOwnMcpEntry(entry)) {
      plan.notes.push(ownMcpEntryNote(AGENTS[agent].label, displayPath(plan, target.path)))
      continue
    }
    if (launch.warning) {
      plan.notes.push(launch.warning)
    }
    if (agent === 'codex' && scope === 'project') {
      plan.notes.push(CODEX_PROJECT_NOTE)
    }
    const stale = entry !== undefined && isStaleMcpEntry(entry, scope, context.platform)
    if (entry !== undefined && !stale) {
      plan.items.push(target.format === 'claude-cli'
        ? { kind: 'claude-cli', agent: 'claude', scope: 'user', path: target.path, argvs: [] }
        : { kind: 'mcp', agent, scope, change: { path: target.path, next: null } })
      continue
    }
    if (launch.args.some(isNpxScript)) {
      plan.notes.push(NPX_USER_REGISTRATION_REFUSAL)
      continue
    }
    if (target.format === 'claude-cli') {
      const add = claudeUserAddArgv(launch)
      plan.items.push({ kind: 'claude-cli', agent: 'claude', scope: 'user', path: target.path, argvs: stale ? [CLAUDE_USER_REMOVE, add] : [add] })
      continue
    }
    const change = target.format === 'toml'
      ? planCodexMcpServer(target.path, launch, { replace: stale })
      : planJsonMcpServer(target.path, launch, { replace: stale, withType: target.withType })
    plan.items.push({ kind: 'mcp', agent, scope, change, ...(stale ? { stale } : {}) })
  }

  plan.notes = [...new Set(plan.notes)]
  return plan
}

/**
 * The plan that takes kanbo out of these agents' files: the block and the
 * `kanbo` MCP entry, nothing else. A project's `AGENTS.md` is Codex's and
 * Cursor's both, so its block goes only when every agent that reads it is
 * being disconnected here. A block or an MCP entry that is not kanbo's own
 * shape goes only on a yes at a terminal, or `--yes`.
 */
export async function planDisconnect(
  requests: AgentRequest[],
  context: { projectDir: string, yes?: boolean, /** False when nobody may be asked (a dry run). */ prompt?: boolean },
): Promise<ConnectPlan> {
  const plan: ConnectPlan = { projectDir: context.projectDir, items: [], notes: [] }
  const removing = new Set(requests.map(request => request.agent))
  const asking = { yes: context.yes, prompt: context.prompt }

  for (const { agent, instructions: scope } of requests) {
    const path = scope === null ? null : AGENTS[agent].instructionPath(scope, context.projectDir)
    if (scope === null || path === null || plan.items.some(item => item.kind === 'instructions' && item.change.path === path)) {
      continue
    }
    const sharers = AGENT_IDS.filter(other => other !== agent && AGENTS[other].instructionPath(scope, context.projectDir) === path)
    const staying = sharers.filter(other => !removing.has(other))
    if (staying.length > 0) {
      if (readInstructionBlockState(path, INSTRUCTION_BLOCK) !== null) {
        const others = staying.map(other => AGENTS[other].label).join(' and ')
        plan.notes.push(`${displayPath(plan, path)} section kept — ${others} also read${staying.length === 1 ? 's' : ''} it. `
          + `Remove it with: kanbo connect ${staying.join(' ')} --remove`)
      }
      continue
    }
    const asked = await planInstructionBlockRemovalAsking(path, { ...asking, label: displayPath(plan, path) })
    if (asked.note) {
      plan.notes.push(asked.note)
    }
    plan.items.push({ kind: 'instructions', agents: [agent, ...sharers.filter(other => removing.has(other))], scope, change: asked.change })
  }

  for (const { agent, mcp: scope } of requests) {
    if (scope === null) {
      continue
    }
    const target = AGENTS[agent].mcpTarget(scope, context.projectDir)
    const entry = readMcpEntry(target)
    const remove = entry !== undefined && (isOwnMcpEntry(entry) || await confirmOwnEntryRemoval(AGENTS[agent].label, displayPath(plan, target.path), asking, plan))
    if (target.format === 'claude-cli') {
      plan.items.push({ kind: 'claude-cli', agent: 'claude', scope: 'user', path: target.path, argvs: remove ? [CLAUDE_USER_REMOVE] : [] })
      continue
    }
    const change = !remove
      ? { path: target.path, next: null }
      : target.format === 'toml' ? planCodexMcpServerRemoval(target.path) : planJsonMcpServerRemoval(target.path)
    plan.items.push({ kind: 'mcp', agent, scope, change })
  }
  plan.notes = [...new Set(plan.notes)]
  return plan
}

/** Remove a `kanbo` MCP entry the person set up themselves? Only on `--yes`, or a yes at a terminal (default no). */
export async function confirmOwnEntryRemoval(
  label: string,
  path: string,
  options: { yes?: boolean, prompt?: boolean },
  plan?: Pick<ConnectPlan, 'notes'>,
): Promise<boolean> {
  const remove = Boolean(options.yes) || (options.prompt !== false && canPrompt() && await getUi().confirm({
    message: `${label}: ${path} has a kanbo entry you set up yourself. Remove it anyway?`,
    initialValue: false,
  }))
  if (!remove) {
    plan?.notes.push(`${ownMcpEntryNote(label, path)} Remove it with --yes.`)
  }
  return remove
}

/** The `kanbo` entry an MCP target holds, `undefined` when it holds none. */
export function readMcpEntry(target: McpTarget): McpEntry | undefined {
  return target.format === 'toml' ? readCodexMcpEntry(target.path) : readJsonMcpEntry(target.path)
}

/**
 * What the `kanbo` MCP entry of one agent in one scope is: kanbo's own and
 * starting, missing, kanbo's own gone stale, or the person's own (`own`),
 * which kanbo leaves as it is.
 */
export type McpState = 'ok' | 'missing' | 'stale' | 'own'

export function readMcpState(agent: AgentId, scope: McpScope, projectDir: string, platform?: NodeJS.Platform): McpState {
  const entry = readMcpEntry(AGENTS[agent].mcpTarget(scope, projectDir))
  if (entry === undefined) {
    return 'missing'
  }
  if (!isOwnMcpEntry(entry)) {
    return 'own'
  }
  return isStaleMcpEntry(entry, scope, platform) ? 'stale' : 'ok'
}

/** What the instruction block for one agent in one scope is; `null` when that scope has no file for it. */
export function readInstructionState(agent: AgentId, scope: McpScope, projectDir: string): InstructionBlockState | 'missing' | null {
  const path = AGENTS[agent].instructionPath(scope, projectDir)
  if (path === null) {
    return null
  }
  return readInstructionBlockState(path, scope === 'project' ? INSTRUCTION_BLOCK : GLOBAL_INSTRUCTION_BLOCK) ?? 'missing'
}

/** The items that change something. */
export function pendingItems(plan: ConnectPlan): ConnectItem[] {
  return plan.items.filter(item => (item.kind === 'claude-cli' ? item.argvs.length > 0 : item.change.next !== null))
}

export function itemPath(item: ConnectItem): string {
  return item.kind === 'claude-cli' ? item.path : item.change.path
}

/** One line saying what an item is for, for the person deciding whether to keep it. */
export function explainItem(item: ConnectItem, removal = false): string {
  const where = item.scope === 'project' ? 'in this project' : 'in every project'
  switch (item.kind) {
    case 'instructions': {
      const readers = item.agents.map(agent => AGENTS[agent].label).join(' and ')
      return removal
        ? `the kanbo section ${readers} reads ${where}`
        : `the kanbo section: ${readers} read${item.agents.length === 1 ? 's' : ''} it ${where} and runs kanbo prime before a task`
    }
    case 'mcp':
      return removal
        ? `the kanbo MCP server ${AGENTS[item.agent].label} starts ${where}`
        : `${item.stale ? 'rewrites a kanbo MCP entry that no longer starts: ' : ''}lets ${AGENTS[item.agent].label} call the board's tools ${where}`
    case 'claude-cli':
      return item.argvs.map(argv => displayCommand(argv)).join(', then ')
  }
}

/** The plan as a person reads it before saying yes. */
export function describeConnectPlan(plan: ConnectPlan, title: string, removal = false): string {
  const lines = [title]
  for (const item of pendingItems(plan)) {
    const verb = item.kind === 'claude-cli' ? 'run  ' : removal ? 'edit ' : 'write'
    lines.push(item.kind === 'claude-cli'
      ? `  ${verb}  ${explainItem(item, removal)}`
      : `  ${verb}  ${displayPath(plan, itemPath(item))} (${explainItem(item, removal)})`)
  }
  for (const note of plan.notes) {
    lines.push(`Note: ${note}`)
  }
  lines.push('Nothing else is changed.')
  return lines.join('\n')
}

export function displayPath(plan: Pick<ConnectPlan, 'projectDir'>, path: string): string {
  const inside = relative(plan.projectDir, path)
  return inside.startsWith('..') || inside === '' || /^[a-z]:/i.test(inside) ? path : inside
}

/** Carry the plan out, item by item, and say what happened to each. */
export function applyConnectPlan(plan: ConnectPlan): ConnectOutcome[] {
  return plan.items.map((item) => {
    const agents = item.kind === 'instructions' ? item.agents : [item.agent]
    if (item.kind !== 'claude-cli') {
      return { kind: item.kind, agents, scope: item.scope, ...applyFileChange(item.change) }
    }
    const base = { kind: item.kind, agents, scope: item.scope, path: item.path }
    let command: string | undefined
    for (const [index, argv] of item.argvs.entries()) {
      const outcome = runClaudeMcp(argv)
      command = outcome.command
      if (outcome.state === 'manual') {
        // What is left to run: this command and the ones after it — never one that already ran.
        const left = item.argvs.slice(index).map(line => displayCommand(line)).join('\n')
        return { ...base, state: 'manual' as const, command: left, reason: outcome.reason, ...(index > 0 ? { removed: true } : {}) }
      }
    }
    return command ? { ...base, state: 'ran' as const, command } : { ...base, state: 'unchanged' as const }
  })
}

/**
 * What the person reads about `claude mcp` commands left to them: each on a
 * line of its own, so each can be pasted into any shell — PowerShell has no `&&`.
 */
export function describeManualOutcome(who: string, outcome: Pick<ConnectOutcome, 'command' | 'reason' | 'removed'>): string {
  const commands = (outcome.command ?? '').split('\n').map(line => `  ${line}`).join('\n')
  return outcome.removed
    ? `${who}: the old kanbo entry was removed, but adding the new one failed (${outcome.reason}). Add it yourself:\n${commands}`
    : `${who}: run this yourself (${outcome.reason}):\n${commands}`
}

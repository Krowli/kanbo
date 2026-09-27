import { relative } from 'node:path'

import type { AgentId, McpTarget } from './agents'
import { AGENT_IDS, AGENTS } from './agents'
import type { FileChange } from './file-change'
import { applyFileChange } from './file-change'
import type { InstructionBlockState } from './instructions'
import {
  GLOBAL_INSTRUCTION_BLOCK,
  INSTRUCTION_BLOCK,
  planInstructionBlockAsking,
  planInstructionBlockRemoval,
  readInstructionBlockState,
} from './instructions'
import type { McpEntry } from './mcp-config'
import {
  CLAUDE_USER_REMOVE,
  claudeUserAddArgv,
  displayCommand,
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
  command?: string
  reason?: string
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
    const asked = await planInstructionBlockAsking(path, block, { yes: context.yes })
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
    const stale = entry !== undefined && isStaleMcpEntry(entry, scope, context.platform)
    if (launch.warning) {
      plan.notes.push(launch.warning)
    }
    if (agent === 'codex' && scope === 'project') {
      plan.notes.push(CODEX_PROJECT_NOTE)
    }
    if (target.format === 'claude-cli') {
      const add = claudeUserAddArgv(launch)
      plan.items.push({
        kind: 'claude-cli',
        agent: 'claude',
        scope: 'user',
        path: target.path,
        argvs: entry === undefined ? [add] : stale ? [CLAUDE_USER_REMOVE, add] : [],
      })
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
 * Cursor's both, so its block stays while the other one is still connected —
 * still has a `kanbo` MCP entry — and is not being disconnected too.
 */
export function planDisconnect(requests: AgentRequest[], context: { projectDir: string }): ConnectPlan {
  const plan: ConnectPlan = { projectDir: context.projectDir, items: [], notes: [] }
  const removing = new Set(requests.map(request => request.agent))

  for (const { agent, instructions: scope } of requests) {
    const path = scope === null ? null : AGENTS[agent].instructionPath(scope, context.projectDir)
    if (scope === null || path === null || plan.items.some(item => item.kind === 'instructions' && item.change.path === path)) {
      continue
    }
    const sharers = AGENT_IDS.filter(other => other !== agent && AGENTS[other].instructionPath(scope, context.projectDir) === path)
    const stillUsing = sharers.filter(other => !removing.has(other) && isMcpConnected(other, context.projectDir))
    if (stillUsing.length > 0) {
      if (readInstructionBlockState(path, INSTRUCTION_BLOCK) !== null) {
        plan.notes.push(`${path}: kept the kanbo section, ${stillUsing.map(other => AGENTS[other].label).join(' and ')} still use${stillUsing.length === 1 ? 's' : ''} it.`)
      }
      continue
    }
    plan.items.push({ kind: 'instructions', agents: [agent, ...sharers.filter(other => removing.has(other))], scope, change: planInstructionBlockRemoval(path) })
  }

  for (const { agent, mcp: scope } of requests) {
    if (scope === null) {
      continue
    }
    const target = AGENTS[agent].mcpTarget(scope, context.projectDir)
    if (target.format === 'claude-cli') {
      plan.items.push({ kind: 'claude-cli', agent: 'claude', scope: 'user', path: target.path, argvs: readMcpEntry(target) === undefined ? [] : [CLAUDE_USER_REMOVE] })
      continue
    }
    const change = target.format === 'toml' ? planCodexMcpServerRemoval(target.path) : planJsonMcpServerRemoval(target.path)
    plan.items.push({ kind: 'mcp', agent, scope, change })
  }
  return plan
}

/** The `kanbo` entry an MCP target holds, `undefined` when it holds none. */
export function readMcpEntry(target: McpTarget): McpEntry | undefined {
  return target.format === 'toml' ? readCodexMcpEntry(target.path) : readJsonMcpEntry(target.path)
}

/** What the `kanbo` MCP entry of one agent in one scope is: there and starting, missing, or kanbo's own gone stale. */
export type McpState = 'ok' | 'missing' | 'stale'

export function readMcpState(agent: AgentId, scope: McpScope, projectDir: string, platform?: NodeJS.Platform): McpState {
  const entry = readMcpEntry(AGENTS[agent].mcpTarget(scope, projectDir))
  if (entry === undefined) {
    return 'missing'
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

function isMcpConnected(agent: AgentId, projectDir: string): boolean {
  return (['project', 'user'] as const).some(scope => readMcpState(agent, scope, projectDir) !== 'missing')
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
    for (const argv of item.argvs) {
      const outcome = runClaudeMcp(argv)
      command = outcome.command
      if (outcome.state === 'manual') {
        return { ...base, state: 'manual' as const, command: item.argvs.map(line => displayCommand(line)).join(' && '), reason: outcome.reason }
      }
    }
    return command ? { ...base, state: 'ran' as const, command } : { ...base, state: 'unchanged' as const }
  })
}

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { McpScope } from './mcp-launch'
import type { PathLookup } from './paths'
import { claudeConfigDir, codexHome, findOnPath, geminiDir, globalInstructionPath, globalMcpConfigPath } from './paths'

/**
 * The agent tools kanbo can connect a project — or a person — to, and for
 * each one: how to tell it is here, which file it reads its standing
 * instructions from, and where it keeps its MCP servers.
 *
 * `kanbo connect`, `kanbo init`, `kanbo uninstall` and `kanbo doctor` all read
 * this one table, so a file one of them writes is a file the others find.
 * Each path was checked against the tool's own documentation (`docs/agents.md`
 * lists the pages); the ones that move with an environment variable are
 * resolved on every call, in `paths.ts`.
 */

export const AGENT_IDS = ['claude', 'codex', 'cursor', 'gemini'] as const
export type AgentId = typeof AGENT_IDS[number]

/**
 * Where an agent keeps its MCP servers, in the format it reads:
 * - `json` — an `mcpServers` map; Gemini CLI's entries carry no `type`, the
 *   others' say `"type": "stdio"`;
 * - `toml` — Codex's `[mcp_servers.<name>]` tables;
 * - `claude-cli` — Claude Code's own `~/.claude.json`, read here but only ever
 *   changed through `claude mcp add` and `claude mcp remove`.
 */
export type McpTarget =
  | { format: 'json', path: string, withType: boolean }
  | { format: 'toml', path: string }
  | { format: 'claude-cli', path: string }

export interface AgentDefinition {
  id: AgentId
  /** The name a person knows it by. */
  label: string
  /** The command it is started with. */
  binary: string
  /** The file its instructions go in, for one project or for every one; `null` when there is none kanbo can write. */
  instructionPath: (scope: McpScope, projectDir: string) => string | null
  /** Where its MCP servers are registered, for one project or for every one. */
  mcpTarget: (scope: McpScope, projectDir: string) => McpTarget
  /**
   * Where the MCP server is registered when nothing says: the project, which
   * travels with it, unless the tool reads a project's file only in some cases
   * — Codex loads `.codex/config.toml` only for projects it trusts. On Windows
   * every tool defaults to the person's own configuration (`defaultMcpScope`).
   */
  mcpScope: McpScope
  /** What the person is told when a scope has no instruction file kanbo can write. */
  noInstructionFile?: string
}

/** The instruction files a project's agents read. Codex and Cursor share `AGENTS.md`. */
export const PROJECT_AGENT_FILES = { claude: 'CLAUDE.md', codex: 'AGENTS.md', cursor: 'AGENTS.md', gemini: 'GEMINI.md' } as const

export const AGENTS: Record<AgentId, AgentDefinition> = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    binary: 'claude',
    instructionPath: (scope, projectDir) => (scope === 'project' ? join(projectDir, PROJECT_AGENT_FILES.claude) : globalInstructionPath('claude')),
    mcpTarget: (scope, projectDir) => (scope === 'project'
      ? { format: 'json', path: join(projectDir, '.mcp.json'), withType: true }
      : { format: 'claude-cli', path: globalMcpConfigPath('claude') }),
    mcpScope: 'project',
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    binary: 'codex',
    instructionPath: (scope, projectDir) => (scope === 'project' ? join(projectDir, PROJECT_AGENT_FILES.codex) : globalInstructionPath('codex')),
    mcpTarget: (scope, projectDir) => ({
      format: 'toml',
      path: scope === 'project' ? join(projectDir, '.codex', 'config.toml') : globalMcpConfigPath('codex'),
    }),
    mcpScope: 'user',
  },
  cursor: {
    id: 'cursor',
    label: 'Cursor',
    binary: 'cursor',
    instructionPath: (scope, projectDir) => (scope === 'project' ? join(projectDir, PROJECT_AGENT_FILES.cursor) : null),
    mcpTarget: (scope, projectDir) => ({
      format: 'json',
      path: scope === 'project' ? join(projectDir, '.cursor', 'mcp.json') : globalMcpConfigPath('cursor'),
      withType: true,
    }),
    mcpScope: 'project',
    noInstructionFile: 'Cursor keeps its rules for every project in its settings, not in a file: paste the kanbo block '
      + 'into Cursor Settings → Rules → User Rules yourself.',
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini CLI',
    binary: 'gemini',
    instructionPath: (scope, projectDir) => (scope === 'project' ? join(projectDir, PROJECT_AGENT_FILES.gemini) : globalInstructionPath('gemini')),
    mcpTarget: (scope, projectDir) => ({
      format: 'json',
      path: scope === 'project' ? join(projectDir, '.gemini', 'settings.json') : join(geminiDir(), 'settings.json'),
      withType: false,
    }),
    mcpScope: 'project',
  },
}

/** Where the MCP server goes when no scope is named: on Windows always the person's own configuration. */
export function defaultMcpScope(agent: AgentId, platform: NodeJS.Platform = process.platform): McpScope {
  return platform === 'win32' ? 'user' : AGENTS[agent].mcpScope
}

/** The agent's name as typed on the command line, or `null` when it is none of them. */
export function parseAgentId(name: string): AgentId | null {
  return AGENT_IDS.find(id => id === name.trim().toLowerCase()) ?? null
}

/** What was found of one agent on this machine and in this project. */
export interface AgentDetection {
  agent: AgentId
  detected: boolean
  /** Each thing that gave it away: its command on `PATH`, its folder, a project file. */
  evidence: string[]
}

export interface DetectionInput extends PathLookup {
  projectDir: string
}

/**
 * Is the agent used here? Its command on `PATH`, the folder it keeps its user
 * files in, the app where it installs one, or a file of its own in the project
 * — any of them is enough. Only a guess for what to offer: nothing is written
 * because an agent was detected.
 */
export function detectAgent(agent: AgentId, input: DetectionInput): AgentDetection {
  const platform = input.platform ?? process.platform
  const env = input.env ?? process.env
  const evidence: string[] = []
  const binary = findOnPath(AGENTS[agent].binary, { platform, env })
  if (binary) {
    evidence.push(binary)
  }
  for (const path of [...userFolders(agent, platform, env), ...PROJECT_MARKERS[agent].map(name => join(input.projectDir, name))]) {
    if (existsSync(path)) {
      evidence.push(path)
    }
  }
  return { agent, detected: evidence.length > 0, evidence }
}

export function detectAgents(input: DetectionInput): AgentDetection[] {
  return AGENT_IDS.map(agent => detectAgent(agent, input))
}

/** Files and folders in a project that say the agent is used there. */
const PROJECT_MARKERS: Record<AgentId, string[]> = {
  claude: ['CLAUDE.md', '.claude'],
  codex: ['.codex'],
  cursor: ['.cursor'],
  gemini: ['.gemini'],
}

function userFolders(agent: AgentId, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  switch (agent) {
    case 'claude': return [claudeConfigDir()]
    case 'codex': return [codexHome()]
    case 'gemini': return [geminiDir()]
    case 'cursor': return [
      join(homedir(), '.cursor'),
      ...(platform === 'darwin' ? ['/Applications/Cursor.app'] : []),
      ...(platform === 'win32' && env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, 'Programs', 'cursor')] : []),
    ]
  }
}

/** Every instruction file kanbo may have written in this scope, each once. */
export function instructionPaths(scope: McpScope, projectDir: string): { path: string, agents: AgentId[] }[] {
  const byPath = new Map<string, AgentId[]>()
  for (const agent of AGENT_IDS) {
    const path = AGENTS[agent].instructionPath(scope, projectDir)
    if (path) {
      byPath.set(path, [...(byPath.get(path) ?? []), agent])
    }
  }
  return [...byPath].map(([path, agents]) => ({ path, agents }))
}

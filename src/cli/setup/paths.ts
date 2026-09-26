import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'

/**
 * Where each agent tool keeps the files kanbo writes into, for one project and
 * for the person's whole machine.
 *
 * Resolved on every call rather than at import, so `HOME` and `CODEX_HOME` set
 * by a test (or a person) are the ones obeyed. Each path was checked against
 * the tool's own documentation; `docs/agents.md` lists the pages.
 */

/** The tools whose user-level instruction file `kanbo init --global` can write. */
export const GLOBAL_INSTRUCTION_CLIENTS = ['claude', 'codex', 'gemini'] as const
export type GlobalInstructionClient = typeof GLOBAL_INSTRUCTION_CLIENTS[number]

/** The files a project's agents read their standing instructions from. */
export const PROJECT_INSTRUCTION_FILES = { claude: 'CLAUDE.md', agents: 'AGENTS.md' } as const
export type ProjectInstructionTarget = keyof typeof PROJECT_INSTRUCTION_FILES

/** The tools that can be told about the board's MCP server. */
export const MCP_CLIENTS = ['claude', 'codex', 'cursor'] as const
export type McpClient = typeof MCP_CLIENTS[number]

/** Where Codex keeps its global files: `$CODEX_HOME`, else `~/.codex`. */
export function codexHome(): string {
  return process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')
}

/** The user-level instruction file of each tool. */
export function globalInstructionPath(client: GlobalInstructionClient): string {
  switch (client) {
    case 'claude': return join(homedir(), '.claude', 'CLAUDE.md')
    case 'codex': return join(codexHome(), 'AGENTS.md')
    case 'gemini': return join(homedir(), '.gemini', 'GEMINI.md')
  }
}

/**
 * The user-level MCP configuration of each tool. Claude Code's is
 * `~/.claude.json`, its own state file: kanbo reads it but never writes it —
 * `claude mcp add` and `claude mcp remove` do.
 */
export function globalMcpConfigPath(client: McpClient): string {
  switch (client) {
    case 'claude': return join(homedir(), '.claude.json')
    case 'codex': return join(codexHome(), 'config.toml')
    case 'cursor': return join(homedir(), '.cursor', 'mcp.json')
  }
}

/** The project-level MCP configuration of each tool. */
export function projectMcpConfigPath(projectDir: string, client: McpClient): string {
  switch (client) {
    case 'claude': return join(projectDir, '.mcp.json')
    case 'codex': return join(projectDir, '.codex', 'config.toml')
    case 'cursor': return join(projectDir, '.cursor', 'mcp.json')
  }
}

/**
 * Every executable of that name on `PATH`, in the order a shell would find
 * them. A path with a separator in it is looked at directly, as a shell does.
 */
export function findAllOnPath(command: string): string[] {
  if (isAbsolute(command) || command.includes('/')) {
    return isExecutableFile(command) ? [command] : []
  }
  const extensions = process.platform === 'win32'
    ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')]
    : ['']
  const found: string[] = []
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, command + extension)
      if (isExecutableFile(candidate) && !found.includes(candidate)) {
        found.push(candidate)
      }
    }
  }
  return found
}

/** The executable a shell would start for that command, or `null` when there is none. */
export function findOnPath(command: string): string | null {
  return findAllOnPath(command)[0] ?? null
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) {
      return false
    }
    accessSync(path, constants.X_OK)
    return true
  }
  catch {
    return false
  }
}

import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

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

/**
 * Where Claude Code keeps its user files: `$CLAUDE_CONFIG_DIR`, else
 * `~/.claude`. Its documentation says every `~/.claude` path moves there; it
 * does not say `~/.claude.json` does, so that one is not moved here.
 */
export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude')
}

/** Gemini CLI makes its `.gemini` folder in `$GEMINI_CLI_HOME`, else in the home directory. */
export function geminiDir(): string {
  return join(process.env.GEMINI_CLI_HOME?.trim() || homedir(), '.gemini')
}

/** The user-level instruction file of each tool. */
export function globalInstructionPath(client: GlobalInstructionClient): string {
  switch (client) {
    case 'claude': return join(claudeConfigDir(), 'CLAUDE.md')
    case 'codex': return join(codexHome(), 'AGENTS.md')
    case 'gemini': return join(geminiDir(), 'GEMINI.md')
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

/** What a `PATH` lookup reads: the OS it follows the rules of, and the environment. Both default to this process's. */
export interface PathLookup {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
}

/** What Windows tries when `PATHEXT` is not set. */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'

/**
 * Every executable of that name on `PATH`, in the order a shell would find
 * them. A path with a separator in it is looked at directly, as a shell does.
 *
 * On Windows a name is tried with each `PATHEXT` extension, compared without
 * regard to case, and the bare name only when it already ends in one of them:
 * npm puts an extensionless `sh` script beside every `.cmd` shim, and that
 * script is not something Windows can start. Windows has no executable bit, so
 * there a file is enough.
 */
export function findAllOnPath(command: string, lookup: PathLookup = {}): string[] {
  const platform = lookup.platform ?? process.platform
  const env = lookup.env ?? process.env
  const windows = platform === 'win32'
  const extensions = windows ? windowsCandidateExtensions(command, env) : ['']
  const isRunnable = windows ? isFile : isExecutableFile

  if (isAbsolute(command) || command.includes('/') || (windows && command.includes('\\'))) {
    return extensions.map(extension => command + extension).filter(isRunnable).slice(0, 1)
  }
  const found: string[] = []
  const pathValue = env.PATH ?? (windows ? env.Path : undefined) ?? ''
  for (const directory of pathValue.split(windows ? ';' : ':').filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, command + extension)
      if (isRunnable(candidate) && !found.includes(candidate)) {
        found.push(candidate)
      }
    }
  }
  return found
}

/** The endings Windows tries on a name: the name as it is only when it already has a `PATHEXT` one. */
function windowsCandidateExtensions(command: string, env: NodeJS.ProcessEnv): string[] {
  const pathext = (env.PATHEXT ?? DEFAULT_PATHEXT).split(';').map(extension => extension.trim().toLowerCase()).filter(Boolean)
  const lower = command.toLowerCase()
  return pathext.some(extension => lower.endsWith(extension)) ? [''] : pathext
}

/** The executable a shell would start for that command, or `null` when there is none. */
export function findOnPath(command: string, lookup: PathLookup = {}): string | null {
  return findAllOnPath(command, lookup)[0] ?? null
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  }
  catch {
    return false
  }
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

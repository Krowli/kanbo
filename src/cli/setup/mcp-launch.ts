import { realpathSync } from 'node:fs'

/**
 * How an MCP registration starts the board's server.
 *
 * Everywhere but Windows that is the portable `kanbo mcp`. On Windows `kanbo`
 * is npm's `kanbo.cmd` shim, which a client that starts programs without a
 * shell (Codex, for one) cannot run. A registration of the person's own —
 * user scope — therefore names this Node and the script it is running
 * instead, which every client can start. A project file is shared with people
 * on other machines and other systems, so it keeps the portable form, and the
 * person is told why that may not start here.
 */

/** Whose registration it is: the project's shared file, or the person's own configuration. */
export type McpScope = 'project' | 'user'

/** The command and its arguments. */
export interface McpLaunch {
  command: string
  args: string[]
}

export interface McpLaunchSpec extends McpLaunch {
  /** Why this form may not start on this machine, when it may not. */
  warning?: string
}

export interface McpLaunchInput {
  scope: McpScope
  /** Defaults to this process's. */
  platform?: NodeJS.Platform
  /** The Node that runs kanbo; defaults to this process's. */
  execPath?: string
  /** The script this kanbo runs from; defaults to the real path of this process's. */
  script?: string | null
}

/** The portable form, the same on every system. */
export const PORTABLE_MCP_LAUNCH: McpLaunch = { command: 'kanbo', args: ['mcp'] }

export const WINDOWS_PROJECT_MCP_WARNING
  = 'On Windows, `kanbo` in a project file starts only in clients that run programs through a shell; '
    + 'Codex does not. Register kanbo in your own settings instead: kanbo connect <agent> without --project.'

export function mcpLaunchSpec(input: McpLaunchInput): McpLaunchSpec {
  const platform = input.platform ?? process.platform
  if (platform !== 'win32') {
    return { ...PORTABLE_MCP_LAUNCH, args: [...PORTABLE_MCP_LAUNCH.args] }
  }
  if (input.scope === 'project') {
    return { ...PORTABLE_MCP_LAUNCH, args: [...PORTABLE_MCP_LAUNCH.args], warning: WINDOWS_PROJECT_MCP_WARNING }
  }
  const script = input.script === undefined ? runningScript() : input.script
  if (!script) {
    return { ...PORTABLE_MCP_LAUNCH, args: [...PORTABLE_MCP_LAUNCH.args] }
  }
  return { command: input.execPath ?? process.execPath, args: [script, 'mcp'] }
}

/** The real path of the script this process runs (`dist/cli.cjs`), past any link npm made to it. */
function runningScript(): string | null {
  const script = process.argv[1]
  if (!script) {
    return null
  }
  try {
    return realpathSync(script)
  }
  catch {
    return null
  }
}

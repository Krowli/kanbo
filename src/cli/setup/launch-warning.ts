import type { PathLookup } from './paths'
import { findOnPath } from './paths'

/**
 * Whether the agents a person is about to connect can start `kanbo mcp` at all.
 *
 * Every registration kanbo writes starts the board's MCP server as `kanbo mcp`
 * (or, in a person's own settings on Windows, this Node and this script). A
 * kanbo run from npx lives in npm's cache for as long as that one command runs
 * and is on nobody's `PATH` afterwards, and a kanbo that is not on `PATH` is
 * not found by an agent either — so the person is told to install it.
 */

export const NOT_INSTALLED_FIX = 'npm install -g kanbo-cli'

export const NPX_LAUNCH_WARNING = `kanbo runs from npx; agents can't start \`kanbo mcp\` until it's installed: ${NOT_INSTALLED_FIX}`

export const NOT_ON_PATH_WARNING = `kanbo isn't on your PATH; agents can't start \`kanbo mcp\` until it's installed: ${NOT_INSTALLED_FIX}`

export interface LaunchWarningInput extends PathLookup {
  /** The script this process runs — `process.argv[1]`. */
  script?: string
}

/** What to tell the person, or `null` when agents will find kanbo. */
export function readLaunchWarning(input: LaunchWarningInput = {}): string | null {
  const env = input.env ?? process.env
  const script = (input.script ?? process.argv[1] ?? '').replaceAll('\\', '/')
  // npm 7+ runs npx as `npm exec` (it sets `npm_command=exec`), from a folder
  // under its cache named `_npx`. A kanbo that npx found installed is on PATH.
  if (script.includes('/_npx/')) {
    return NPX_LAUNCH_WARNING
  }
  if (findOnPath('kanbo', input)) {
    return null
  }
  return env.npm_command === 'exec' ? NPX_LAUNCH_WARNING : NOT_ON_PATH_WARNING
}

import type { SpawnSyncReturns } from 'node:child_process'

import { KANBO_PACKAGE_VERSION } from '../package-version'
import { spawnCommandSync } from './setup/process'
import type { Ui } from './ui/ui'
import { CancelledError } from './ui/ui'

/**
 * Is there a newer kanbo? Asked of npm on every start, alongside the command,
 * and never in its way.
 *
 * There is no schedule and no cache: each run starts one request for the
 * `latest` version, gives it ~1.5 s, and uses the answer only if it came
 * before the command finished (waiting ~300 ms more at most). A person at a
 * terminal is then asked whether to update; an agent's shell, or any shell
 * with nobody to ask, gets one line on stderr; `kanbo mcp` puts one line into
 * `kanbo_prime`. A network that fails says nothing (`KANBO_DEBUG=1` says why).
 *
 * Nobody is asked in CI, with `KANBO_NO_UPDATE_CHECK=1` or `NO_UPDATE_NOTIFIER`
 * set, for machine output (`--json`, `--format json`), `--version`, `--help`,
 * or `kanbo mcp` — whose stdout is the protocol.
 */

export const LATEST_VERSION_URL = 'https://registry.npmjs.org/kanbo-cli/latest'

/** What updates kanbo, as the person would type it. */
export const UPDATE_COMMAND = 'npm install -g kanbo-cli@latest'

const UPDATE_ARGV = ['npm', ['install', '-g', 'kanbo-cli@latest']] as const

/** How long npm gets to answer. */
export const UPDATE_CHECK_TIMEOUT_MS = 1_500

/** How long a finished command waits for an answer that has not come yet. */
export const UPDATE_CHECK_GRACE_MS = 300

/** A newer kanbo than the one running. */
export interface AvailableUpdate {
  latest: string
  current: string
}

interface Timers {
  setTimeout: (callback: () => void, ms: number) => unknown
  clearTimeout: (handle: never) => void
}

/** What the check runs on — each replaceable by a test. */
export interface UpdateCheckDeps {
  fetch?: typeof globalThis.fetch
  env?: NodeJS.ProcessEnv
  timers?: Timers
  currentVersion?: string
}

export interface UpdateCheck {
  /** The newer version, once npm has said so; `null` before that, or when there is none. */
  peek: () => AvailableUpdate | null
  /** Wait at most `ms` for the answer, then stop asking; what arrived by then. */
  settle: (ms?: number) => Promise<AvailableUpdate | null>
}

/** `CI`, `KANBO_NO_UPDATE_CHECK=1` or `NO_UPDATE_NOTIFIER`: this environment is never asked about updates. */
export function isUpdateCheckDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isOn(env.CI) || env.KANBO_NO_UPDATE_CHECK?.trim() === '1' || isSet(env.NO_UPDATE_NOTIFIER)
}

/**
 * Does `kanbo <args>` skip the check — `mcp`, machine output, `--version`,
 * `--help` or `kanbo help` — or does the environment?
 */
export function skipsUpdateCheck(args: readonly string[], env: NodeJS.ProcessEnv = process.env): boolean {
  if (isUpdateCheckDisabled(env) || args[0] === 'mcp' || args[0] === 'help') {
    return true
  }
  return args.some((arg, index) => arg === '--json'
    || arg.startsWith('--json=')
    || arg === '--format=json'
    || (arg === '--format' && args[index + 1] === 'json')
    || arg === '--version'
    || arg === '-V'
    || arg === '--help'
    || arg === '-h')
}

/** Start asking npm for the latest version. Never throws, never rejects. */
export function startUpdateCheck(deps: UpdateCheckDeps = {}): UpdateCheck {
  const fetchLatest = deps.fetch ?? globalThis.fetch
  const env = deps.env ?? process.env
  const timers = deps.timers ?? { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout } as unknown as Timers
  const current = deps.currentVersion ?? KANBO_PACKAGE_VERSION
  const controller = new AbortController()
  let found: AvailableUpdate | null = null

  const timeout = timers.setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS)
  const answer: Promise<void> = (async () => {
    try {
      const response = await fetchLatest(LATEST_VERSION_URL, { signal: controller.signal, headers: { accept: 'application/json' } })
      if (!response.ok) {
        throw new Error(`npm answered ${response.status}`)
      }
      const { version } = await response.json() as { version?: unknown }
      if (typeof version !== 'string') {
        throw new TypeError('npm\'s answer names no version')
      }
      if (isNewerVersion(version, current)) {
        found = { latest: version, current }
      }
    }
    catch (error) {
      if (isOn(env.KANBO_DEBUG)) {
        console.error(`kanbo: update check: ${controller.signal.aborted ? 'no answer in time' : error instanceof Error ? error.message : String(error)}`)
      }
    }
    finally {
      timers.clearTimeout(timeout as never)
    }
  })()

  return {
    peek: () => found,
    async settle(ms = UPDATE_CHECK_GRACE_MS) {
      let grace: unknown
      await Promise.race([answer, new Promise<void>((resolve) => {
        grace = timers.setTimeout(resolve, ms)
      })])
      timers.clearTimeout(grace as never)
      controller.abort()
      return found
    },
  }
}

/**
 * Is `latest` newer than `current`? A pre-release counts only when a
 * pre-release is running; a release is newer than its own pre-releases.
 */
export function isNewerVersion(latest: string, current: string): boolean {
  const next = parseVersion(latest)
  const running = parseVersion(current)
  if (!next || !running || (next.pre.length > 0 && running.pre.length === 0)) {
    return false
  }
  for (let index = 0; index < 3; index++) {
    if (next.core[index] !== running.core[index]) {
      return next.core[index]! > running.core[index]!
    }
  }
  if (next.pre.length === 0 || running.pre.length === 0) {
    return next.pre.length === 0 && running.pre.length > 0
  }
  return comparePreRelease(next.pre, running.pre) > 0
}

function parseVersion(value: string): { core: number[], pre: string[] } | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Z.-]+))?(?:\+\S*)?$/i.exec(value.trim())
  return match ? { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4]?.split('.') ?? [] } : null
}

/** Semver's order of pre-release identifiers: numbers by value and before words, a longer list after its prefix. */
function comparePreRelease(left: string[], right: string[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const a = left[index]
    const b = right[index]
    if (a === undefined || b === undefined) {
      return a === undefined ? -1 : 1
    }
    if (a === b) {
      continue
    }
    const numeric = /^\d+$/
    if (numeric.test(a) && numeric.test(b)) {
      return Number(a) - Number(b)
    }
    if (numeric.test(a) !== numeric.test(b)) {
      return numeric.test(a) ? -1 : 1
    }
    return a < b ? -1 : 1
  }
  return 0
}

/** The line an agent's shell, or any shell with nobody to ask, gets on stderr. */
export function describeUpdateForShell(update: AvailableUpdate): string {
  return `kanbo ${update.latest} is available (you have ${update.current}) — ${UPDATE_COMMAND}`
}

/** The question a person at a terminal is asked. */
export function describeUpdateQuestion(update: AvailableUpdate): string {
  return `kanbo ${update.latest} is available (you have ${update.current}). Update now?`
}

/** The line `kanbo_prime` ends with when `kanbo mcp` runs an older kanbo. */
export function describeUpdateForAgent(update: AvailableUpdate): string {
  return `Note: kanbo ${update.latest} is available (running ${update.current}). Ask a person to update: ${UPDATE_COMMAND}`
}

/** Runs `npm install -g kanbo-cli@latest` with the terminal handed to npm. */
export type UpdateInstaller = () => SpawnSyncReturns<string>

export const installLatestKanbo: UpdateInstaller = () => spawnCommandSync(UPDATE_ARGV[0], UPDATE_ARGV[1], { stdio: 'inherit' })

/** Install the update and say how it went: `Updated to X.`, or what failed and the command to run. */
export function installUpdate(update: AvailableUpdate, install: UpdateInstaller = installLatestKanbo): boolean {
  const result = install()
  if (!result.error && result.status === 0) {
    console.log(`Updated to ${update.latest}.`)
    return true
  }
  const why = result.error ? result.error.message : `npm exited with code ${result.status ?? result.signal ?? '?'}`
  console.error(`kanbo was not updated: ${why}. Run it yourself: ${UPDATE_COMMAND}`)
  return false
}

/**
 * Tell whoever ran the command about a newer kanbo: a person at a terminal is
 * asked (default No) and a yes installs it; anyone else gets one line on stderr.
 */
export async function offerUpdate(
  update: AvailableUpdate,
  context: { ui: Ui, interactive: boolean, install?: UpdateInstaller },
): Promise<void> {
  if (!context.interactive) {
    console.error(describeUpdateForShell(update))
    return
  }
  let yes: boolean
  try {
    yes = await context.ui.confirm({ message: describeUpdateQuestion(update), initialValue: false })
  }
  catch (error) {
    if (error instanceof CancelledError) {
      return
    }
    throw error
  }
  if (yes) {
    installUpdate(update, context.install)
  }
}

/** Set, and not empty, `0` or `false`. */
function isOn(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase()
  return normalized !== undefined && normalized !== '' && normalized !== '0' && normalized !== 'false'
}

function isSet(value: string | undefined): boolean {
  return value !== undefined && value !== ''
}

import type { SpawnSyncReturns } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'

import { KANBO_PACKAGE_VERSION } from '../package-version'
import { isAgentShell } from './actor'
import { isNpxScript } from './setup/launch-warning'
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
 * terminal running a global install is then asked whether to update; an
 * agent's shell (told to ask a person), any shell with nobody to ask, Windows
 * (where a running kanbo cannot replace itself), a project's own install
 * (`npm install kanbo-cli@latest` there) and npx (`npx kanbo-cli@latest`) get
 * one line on stderr instead, and nothing is installed; `kanbo mcp` puts one line into
 * `kanbo_prime`; `kanbo doctor` shows it as a finding. A network that fails
 * says nothing (`KANBO_DEBUG=1` says why).
 *
 * Nobody is asked in CI, with `KANBO_NO_UPDATE_CHECK=1` or `NO_UPDATE_NOTIFIER`
 * set, for machine output (`--json`, `--format json`), `--version`, `--help`,
 * or `kanbo mcp` — whose stdout is the protocol.
 */

export const LATEST_VERSION_URL = 'https://registry.npmjs.org/kanbo-cli/latest'

/** What updates kanbo, as the person would type it. */
export const UPDATE_COMMAND = 'npm install -g kanbo-cli@latest'

const UPDATE_ARGV = ['npm', ['install', '-g', 'kanbo-cli@latest']] as const

/**
 * How the running kanbo was installed: `global` (`npm install -g`), `project`
 * (a `node_modules/kanbo-cli` of this project or a folder above it), or `npx`
 * (npm's cache, for one command). Only a global install is updated in place.
 */
export type InstallKind = 'global' | 'project' | 'npx'

/** What updates each kind of install, as the person would type it. */
export const UPDATE_COMMANDS: Record<InstallKind, string> = {
  global: UPDATE_COMMAND,
  project: 'npm install kanbo-cli@latest',
  npx: 'npx kanbo-cli@latest',
}

export interface InstallKindInput {
  /** The script this process runs — `process.argv[1]`. */
  script?: string
  cwd?: string
  /** This Node — `process.execPath` — whose prefix holds the global `node_modules`. */
  execPath?: string
  platform?: NodeJS.Platform
}

/**
 * How the running kanbo was installed. npx runs it from a folder under npm's
 * cache named `_npx` (`isNpxScript`). A project's own install is a
 * `node_modules/kanbo-cli` in the current folder or one above it — except the
 * global one, which sits under this Node's prefix (`<prefix>/lib/node_modules`,
 * `<prefix>\node_modules` on Windows) and may be above the current folder too.
 * Anything else is a global install.
 */
export function readInstallKind(input: InstallKindInput = {}): InstallKind {
  const script = realPath(input.script ?? process.argv[1] ?? '')
  if (isNpxScript(script)) {
    return 'npx'
  }
  const platform = input.platform ?? process.platform
  const execPath = input.execPath ?? process.execPath
  const globalParent = realPath(platform === 'win32' ? dirname(execPath) : join(dirname(dirname(execPath)), 'lib'))
  let folder = realPath(input.cwd ?? process.cwd())
  while (true) {
    if (folder !== globalParent && script.startsWith(join(folder, 'node_modules', 'kanbo-cli') + sep)) {
      return 'project'
    }
    const parent = dirname(folder)
    if (parent === folder) {
      return 'global'
    }
    folder = parent
  }
}

function realPath(path: string): string {
  try {
    return realpathSync(path)
  }
  catch {
    return path
  }
}

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

/**
 * Can this kanbo replace itself with `npm install -g`? Not on Windows: the
 * running kanbo holds its native SQLite module open, and Windows does not let
 * npm replace a file that is in use.
 */
export function canUpdateInPlace(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32'
}

/**
 * The one line a shell with nobody to ask, anyone on Windows, or anyone not
 * running a global install gets. On Windows a global install is told to close
 * kanbo first (`canUpdateInPlace`); a project's install is updated in that
 * project; npx takes the newest only when asked for `@latest` — without it,
 * it keeps running the copy it has cached.
 */
export function describeUpdateForShell(update: AvailableUpdate, platform: NodeJS.Platform = process.platform, kind: InstallKind = 'global'): string {
  const available = `kanbo ${update.latest} is available (you have ${update.current})`
  if (kind === 'project') {
    return `${available}. This project installs kanbo; update it here: ${UPDATE_COMMANDS.project}`
  }
  if (kind === 'npx') {
    return `${available}. npx runs the newest kanbo when you pass @latest: ${UPDATE_COMMANDS.npx}`
  }
  return canUpdateInPlace(platform)
    ? `${available} — ${UPDATE_COMMAND}`
    : `${available}. Close kanbo and run: ${UPDATE_COMMAND}`
}

/** The line about a newer kanbo for whoever ran this: an agent's shell is told to ask a person (`describeUpdateForAgent`). */
export function describeUpdateLine(update: AvailableUpdate, platform: NodeJS.Platform = process.platform, kind: InstallKind = 'global'): string {
  return isAgentShell() ? describeUpdateForAgent(update, kind) : describeUpdateForShell(update, platform, kind)
}

/** The question a person at a terminal is asked. */
export function describeUpdateQuestion(update: AvailableUpdate): string {
  return `kanbo ${update.latest} is available (you have ${update.current}). Update now?`
}

/** What an agent is told about a newer kanbo — in its shell, and (after `Note: `) at the end of `kanbo_prime`: updating is a person's call. */
export function describeUpdateForAgent(update: AvailableUpdate, kind: InstallKind = 'global'): string {
  return `kanbo ${update.latest} is available (running ${update.current}). Ask a person to update: ${UPDATE_COMMANDS[kind]}`
}

/**
 * Runs `npm install -g kanbo-cli@latest`: npm's progress goes straight to the
 * terminal, its errors come back in `stderr` (and are passed on) so a
 * permissions failure can be recognised.
 */
export type UpdateInstaller = () => SpawnSyncReturns<string>

export const installLatestKanbo: UpdateInstaller = () => {
  const result = spawnCommandSync(UPDATE_ARGV[0], UPDATE_ARGV[1], { stdio: ['inherit', 'inherit', 'pipe'] })
  if (result.stderr) {
    process.stderr.write(result.stderr)
  }
  return result
}

/** Where npm explains fixing a global folder kanbo may not write to. */
export const NPM_PERMISSIONS_URL = 'https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally'

/**
 * Install the update; `true` when it worked. The caller says so — the words
 * depend on whether kanbo keeps running. A failure is said here: what failed,
 * the command to run, and — when npm could not write its global folder — where
 * npm explains the fix.
 */
export function installUpdate(install: UpdateInstaller = installLatestKanbo): boolean {
  const result = install()
  if (!result.error && result.status === 0) {
    return true
  }
  const why = result.error ? result.error.message : `npm exited with code ${result.status ?? result.signal ?? '?'}`
  const lines = [`kanbo was not updated: ${why}. Run it yourself: ${UPDATE_COMMAND}`]
  if (isPermissionFailure(result)) {
    lines.push(`Your npm global folder needs permissions — see ${NPM_PERMISSIONS_URL}`)
  }
  console.error(lines.join('\n'))
  return false
}

/** npm (or starting it) was refused a file: `EACCES` or `EPERM`. */
function isPermissionFailure(result: SpawnSyncReturns<string>): boolean {
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code
  return code === 'EACCES' || code === 'EPERM' || /\bE(?:ACCES|PERM)\b/.test(result.stderr ?? '')
}

/**
 * Tell whoever ran the command about a newer kanbo: a person at a terminal
 * running a global install is asked (default No) and a yes installs it;
 * anyone else — an agent's shell, anyone on Windows, where a running kanbo
 * cannot replace itself, and a project's install or npx, which `npm install
 * -g` would not update — gets one line on stderr.
 */
export async function offerUpdate(
  update: AvailableUpdate,
  context: { ui: Ui, interactive: boolean, install?: UpdateInstaller, platform?: NodeJS.Platform, kind?: InstallKind },
): Promise<void> {
  const platform = context.platform ?? process.platform
  const kind = context.kind ?? 'global'
  if (!context.interactive || !canUpdateInPlace(platform) || kind !== 'global') {
    console.error(describeUpdateLine(update, platform, kind))
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
  if (yes && installUpdate(context.install)) {
    console.log(`Updated to ${update.latest}.`)
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

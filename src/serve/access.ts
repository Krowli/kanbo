import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { findOnPath } from '../cli/setup/paths'
import { spawnDetached } from '../cli/setup/process'
import { assertServeBinding } from './server'

/**
 * The token `kanbo serve` guards the board with, and how the person who
 * started it is handed the page.
 *
 * A token nobody gave is made up for the run, so a loopback server is never
 * open to anything that can reach the port. The person gets it as a link whose
 * fragment carries it — a fragment never reaches a server or its log — and the
 * page keeps it for the tab. Only a person's terminal is handed that link: a
 * shell an agent runs in, or output going anywhere but a terminal, is told a
 * token exists and never what it is, since whoever holds it acts for the person.
 */

/** The token a server runs with, and whether it was made up for this run rather than given. */
export interface ServeAccess {
  token: string
  generated: boolean
}

/** The token given, or one made up for a loopback server; refused off loopback without one. */
export function resolveServeAccess(host: string, givenToken: string | null): ServeAccess {
  assertServeBinding(host, givenToken)
  if (givenToken) {
    return { token: givenToken, generated: false }
  }
  return { token: randomBytes(24).toString('base64url'), generated: true }
}

export interface ServePagePresentation {
  /** The server's address, e.g. `http://127.0.0.1:4318`. */
  url: string
  access: ServeAccess
  /** Started from a shell that says it is an agent's (`KANBO_ACTOR_KIND=agent`). */
  agentShell: boolean
  /** Whether what is printed goes to a terminal rather than a pipe or a file. */
  terminal: boolean
  /** The person asked for the page to open (no `--no-open`). */
  open: boolean
}

export interface ServePageOutput {
  print: (line: string) => void
  openInBrowser: (url: string) => void
}

/**
 * Hand the person the board page: a link printed once, and opened in the
 * browser unless they said not to. A generated token rides in the link's
 * fragment; one they gave is theirs already and is left out.
 */
export function presentServePage(presentation: ServePagePresentation, output: ServePageOutput): void {
  const { url, access, open } = presentation
  if (presentation.agentShell || !presentation.terminal) {
    if (access.generated) {
      output.print('kanbo serve: a token was generated for this run and is not shown here; set KANBO_SERVE_TOKEN to choose your own')
    }
    return
  }
  const link = access.generated ? `${url}/#token=${access.token}` : `${url}/`
  output.print(`kanbo serve: board page ${link}`)
  if (open) {
    output.openInBrowser(link)
  }
}

/** What choosing a browser looks at; each defaults to this machine's. */
export interface BrowserEnvironment {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /** A file's text, or `null` when it cannot be read (`/proc/version`, to tell WSL apart). */
  readFile?: (path: string) => string | null
  /** The program a command names on `PATH`, or `null`. */
  findOnPath?: (command: string) => string | null
}

/** A program that opens a link, with its arguments. */
export interface BrowserLauncher {
  command: string
  args: string[]
}

/**
 * How to open a link in the default browser here, or `null` when there is no
 * browser to open — a Linux machine without a display, over SSH say — and the
 * printed link is all the person gets.
 *
 * Windows gets `rundll32 url.dll,FileProtocolHandler`, which takes the link as
 * one argument: `cmd /c start` would read the `&` and `^` in it as its own.
 * WSL is Linux with Windows' browser: `wslview` when it is installed, else
 * Windows' own `cmd.exe`.
 */
export function chooseBrowserLauncher(url: string, environment: BrowserEnvironment = {}): BrowserLauncher | null {
  const platform = environment.platform ?? process.platform
  const env = environment.env ?? process.env
  const readFile = environment.readFile ?? readTextOrNull
  const onPath = environment.findOnPath ?? (command => findOnPath(command))

  if (platform === 'darwin') {
    return { command: 'open', args: [url] }
  }
  if (platform === 'win32') {
    return { command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] }
  }
  if (/microsoft/i.test(readFile('/proc/version') ?? '')) {
    return onPath('wslview')
      ? { command: 'wslview', args: [url] }
      : { command: 'cmd.exe', args: ['/c', 'start', '""', url] }
  }
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) {
    return null
  }
  return { command: 'xdg-open', args: [url] }
}

/** Open a link in the default browser, without waiting for it and without failing when there is none. */
export function openInBrowser(url: string, environment: BrowserEnvironment = {}): void {
  const launcher = chooseBrowserLauncher(url, environment)
  if (launcher) {
    spawnDetached(launcher.command, launcher.args)
  }
}

function readTextOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  }
  catch {
    return null
  }
}

import { readFileSync } from 'node:fs'

import { runWithInput } from './process'

/**
 * Put text on the person's clipboard, with whatever this machine has for it.
 *
 * - macOS: `pbcopy`.
 * - Windows and WSL: `clip.exe`, fed UTF-16LE with a byte-order mark — handed
 *   plain UTF-8 it reads the bytes in the console's code page and turns every
 *   dash and quote into two or three wrong characters.
 * - Linux under Wayland (`WAYLAND_DISPLAY`): `wl-copy`.
 * - Linux under X11 (`DISPLAY`): `xclip -selection clipboard`, else
 *   `xsel --clipboard --input`. `xclip` stays behind to serve what it copied,
 *   so it is started detached.
 * - Over SSH with none of those: the OSC 52 escape on stderr, which asks the
 *   person's own terminal to take the text — when stderr is a terminal at all.
 *
 * Otherwise nothing is copied and the caller says so: the text is already on
 * the screen to select by hand.
 */

/** How long a clipboard program may take before kanbo gives up on it. */
export const CLIPBOARD_TIMEOUT_MS = 3000

/** What happened to the text. */
export type ClipboardOutcome = 'copied' | 'osc52' | 'unavailable'

/** Run a program with this input on stdin; `true` when it exited `0`. */
export type ClipboardRunner = (
  command: string,
  args: readonly string[],
  input: Uint8Array,
  options: { timeoutMs: number, detached?: boolean },
) => Promise<boolean>

/** What choosing a clipboard looks at; each defaults to this machine's. */
export interface ClipboardEnvironment {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /** A file's text, or `null` when it cannot be read (`/proc/version`, to tell WSL apart). */
  readFile?: (path: string) => string | null
  run?: ClipboardRunner
  /** Where the OSC 52 escape goes: stderr, never the stdout a caller may be piping. */
  stderr?: { isTTY?: boolean, write: (chunk: string) => unknown }
}

/** A program that takes the clipboard's text on stdin. */
interface ClipboardProgram {
  command: string
  args: string[]
  input: Uint8Array
  detached?: boolean
}

/** Copy the text, trying each program this machine should have in turn. */
export async function copyToClipboard(text: string, environment: ClipboardEnvironment = {}): Promise<ClipboardOutcome> {
  const env = environment.env ?? process.env
  const run = environment.run ?? runWithInput
  const stderr = environment.stderr ?? process.stderr

  for (const program of chooseClipboardPrograms(text, environment)) {
    if (await run(program.command, program.args, program.input, { timeoutMs: CLIPBOARD_TIMEOUT_MS, detached: program.detached })) {
      return 'copied'
    }
  }
  if ((env.SSH_TTY || env.SSH_CONNECTION) && stderr.isTTY === true) {
    stderr.write(osc52(text))
    return 'osc52'
  }
  return 'unavailable'
}

/** The programs to try here, in order; empty when there is nothing to try. */
function chooseClipboardPrograms(text: string, environment: ClipboardEnvironment): ClipboardProgram[] {
  const platform = environment.platform ?? process.platform
  const env = environment.env ?? process.env
  const readFile = environment.readFile ?? readTextOrNull
  const utf8 = Buffer.from(text, 'utf8')

  if (platform === 'darwin') {
    return [{ command: 'pbcopy', args: [], input: utf8 }]
  }
  if (platform === 'win32' || (platform === 'linux' && /microsoft/i.test(readFile('/proc/version') ?? ''))) {
    return [{ command: 'clip.exe', args: [], input: utf16leWithBom(text) }]
  }
  const programs: ClipboardProgram[] = []
  if (env.WAYLAND_DISPLAY) {
    programs.push({ command: 'wl-copy', args: [], input: utf8 })
  }
  if (env.DISPLAY) {
    programs.push(
      { command: 'xclip', args: ['-selection', 'clipboard'], input: utf8, detached: true },
      { command: 'xsel', args: ['--clipboard', '--input'], input: utf8 },
    )
  }
  return programs
}

/** The text as `clip.exe` reads it without guessing: UTF-16LE after a byte-order mark. */
export function utf16leWithBom(text: string): Uint8Array {
  return Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(text, 'utf16le')])
}

/** The OSC 52 "set the clipboard" escape for this text. */
export function osc52(text: string): string {
  return `\u001B]52;c;${Buffer.from(text, 'utf8').toString('base64')}\u0007`
}

function readTextOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  }
  catch {
    return null
  }
}

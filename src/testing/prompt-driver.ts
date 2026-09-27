import { PassThrough } from 'node:stream'

import type { Ui } from '../cli/ui/ui'
import { createUi } from '../cli/ui/ui'

/**
 * A person at a terminal, for a test: keys go in, what the prompts draw comes
 * out, and no pty is involved, so it runs the same on every OS.
 *
 * Both streams say they are terminals — `canPrompt` asks, and so does the
 * prompt library before it switches the input to raw mode, which is a no-op
 * here. Pass `driver.ui` to `setUiForTests`, run the command without awaiting
 * it, then `waitFor` a question and `press` the answer.
 */

const KEYS = {
  'enter': '\r',
  'up': '\u001B[A',
  'down': '\u001B[B',
  'space': ' ',
  'ctrl-c': '\u0003',
} as const

export type PromptKey = keyof typeof KEYS

export interface PromptDriver {
  ui: Ui
  press: (...keys: PromptKey[]) => void
  /** Type text as a person would, one character at a time. */
  type: (text: string) => void
  /**
   * Resolve once `text` shows up in the output after the previous match, with
   * terminal control sequences stripped. Rejects after `timeoutMs` with the
   * whole transcript, which is what a failing test needs to show.
   */
  waitFor: (text: string, timeoutMs?: number) => Promise<void>
  /** Everything drawn so far, control sequences stripped. */
  transcript: () => string
}

type TerminalInput = PassThrough & { isTTY: boolean, setRawMode: (mode: boolean) => TerminalInput }
type TerminalOutput = PassThrough & { isTTY: boolean, columns: number, rows: number }

/** CSI and OSC sequences, and the lone escapes that move the cursor. */
// eslint-disable-next-line no-control-regex
const CONTROL_SEQUENCE = /\u001B\[[0-?]*[ -/]*[@-~]|\u001B\][^\u0007]*(?:\u0007|\u001B\\)|\u001B[78]/g

export function createPromptDriver(): PromptDriver {
  const input = Object.assign(new PassThrough(), { isTTY: true }) as TerminalInput
  input.setRawMode = () => input
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 }) as TerminalOutput

  let raw = ''
  output.on('data', (chunk: Buffer) => {
    raw += chunk.toString('utf8')
  })
  const transcript = (): string => raw.replace(CONTROL_SEQUENCE, '')

  let searchFrom = 0

  return {
    ui: createUi({ input, output }),
    press(...keys) {
      for (const key of keys) {
        input.write(KEYS[key])
      }
    },
    type(text) {
      for (const character of text) {
        input.write(character)
      }
    },
    async waitFor(text, timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs
      while (true) {
        const index = transcript().indexOf(text, searchFrom)
        if (index >= 0) {
          searchFrom = index + text.length
          // The prompt draws before it listens for keys; let it finish.
          await new Promise(resolve => setTimeout(resolve, 10))
          return
        }
        if (Date.now() > deadline) {
          throw new Error(`"${text}" did not appear within ${timeoutMs} ms. Transcript:\n${transcript()}`)
        }
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    },
    transcript,
  }
}

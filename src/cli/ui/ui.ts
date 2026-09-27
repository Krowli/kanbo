import type { Readable, Writable } from 'node:stream'

import type { ConfirmOptions, MultiSelectOptions, PasswordOptions, SelectOptions, TextOptions } from '@clack/prompts'

import { CliError } from '../output'

/**
 * Every question kanbo asks a person, in one place.
 *
 * Nothing else imports `@clack/prompts`: a prompt is asked through the `Ui`
 * `getUi()` hands out, which owns the streams it reads keys from and draws on.
 * A test swaps in one built on streams of its own (`src/testing/prompt-driver.ts`)
 * and presses keys, on every OS, with no terminal. The library is loaded on the
 * first question, not at startup — most commands never ask one.
 *
 * A person who presses Ctrl-C (or Escape) is not answering: every prompt throws
 * `CancelledError` instead of handing its caller a sentinel to forget to check.
 */

/** The person stopped the command at a prompt. */
export class CancelledError extends CliError {
  constructor(message = 'Cancelled.') {
    super(1, message)
    this.name = 'CancelledError'
  }
}

/** A question as the prompt library takes it, minus the streams the `Ui` owns. */
type Question<Options> = Omit<Options, 'input' | 'output'>

export interface Ui {
  /** Where keys come from; `canPrompt` asks whether it is a terminal. */
  readonly input: Readable
  /** Where prompts are drawn. */
  readonly output: Writable
  select: <T extends string>(question: Question<SelectOptions<T>>) => Promise<T>
  /** Nothing picked is an answer unless the question says `required: true`. */
  multiselect: <T extends string>(question: Question<MultiSelectOptions<T>>) => Promise<T[]>
  confirm: (question: Question<ConfirmOptions>) => Promise<boolean>
  /** One line of text; an empty answer is the question's `defaultValue`, or `''`. */
  text: (question: Question<TextOptions>) => Promise<string>
  /** The same, with what is typed hidden. */
  password: (question: Question<PasswordOptions>) => Promise<string>
}

/** A `Ui` over these streams — the process's own terminal when none are given. */
export function createUi(streams: { input?: Readable, output?: Writable } = {}): Ui {
  const input = streams.input ?? process.stdin
  const output = streams.output ?? process.stdout
  const io = { input, output }

  return {
    input,
    output,
    async select(question) {
      const prompts = await import('@clack/prompts')
      return answered(prompts, await prompts.select({ ...io, ...question }))
    },
    async multiselect(question) {
      const prompts = await import('@clack/prompts')
      return answered(prompts, await prompts.multiselect({ ...io, required: false, ...question }))
    },
    async confirm(question) {
      const prompts = await import('@clack/prompts')
      return answered(prompts, await prompts.confirm({ ...io, ...question }))
    },
    async text(question) {
      const prompts = await import('@clack/prompts')
      return answered(prompts, await prompts.text({ ...io, ...question })) ?? ''
    },
    async password(question) {
      const prompts = await import('@clack/prompts')
      return answered(prompts, await prompts.password({ ...io, ...question })) ?? ''
    },
  }
}

function answered<T>(prompts: typeof import('@clack/prompts'), answer: T | symbol): Exclude<T, symbol> {
  if (prompts.isCancel(answer)) {
    throw new CancelledError()
  }
  return answer as Exclude<T, symbol>
}

let current: Ui | null = null

/** The `Ui` every command asks through. */
export function getUi(): Ui {
  current ??= createUi()
  return current
}

/** Replace the `Ui` (a prompt driver's), or go back to the terminal's with `null`. */
export function setUiForTests(ui: Ui | null): void {
  current = ui
}

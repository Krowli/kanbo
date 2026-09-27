import { isAgentShell } from '../actor'
import type { Ui } from './ui'
import { getUi } from './ui'

/**
 * Is there a person on the other end to ask?
 *
 * Only when keys come from a terminal and prompts go to one, the terminal can
 * draw them (`TERM=dumb` cannot), this is not a CI run, and the shell does not
 * say it belongs to an agent. Anything else gets no question: the command
 * either takes what its flags said or stops and says which flag to add.
 */
export function canPrompt(ui: Ui = getUi()): boolean {
  const input = ui.input as { isTTY?: boolean }
  const output = ui.output as { isTTY?: boolean }
  return input.isTTY === true
    && output.isTTY === true
    && process.env.TERM !== 'dumb'
    && !isCiRun()
    && !isAgentShell()
}

/** `CI` set to anything but an empty, `0` or `false` value — what every CI service sets. */
function isCiRun(): boolean {
  const ci = process.env.CI?.trim().toLowerCase()
  return ci !== undefined && ci !== '' && ci !== '0' && ci !== 'false'
}

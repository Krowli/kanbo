import { CliError } from '../output'
import { canPrompt } from '../ui/environment'
import { getUi } from '../ui/ui'

/**
 * Show a plan of file changes and ask before carrying it out.
 *
 * `--yes` is the answer given in advance. A shell with nobody at its terminal
 * cannot be asked, so it is refused rather than taken as a yes: these commands
 * write into a person's own configuration, which is the kind of thing a person
 * says yes to. When the caller asked for machine output, stdout belongs to the
 * result and the plan goes to stderr.
 */
export async function confirmPlan(input: {
  preview: string
  question: string
  yes: boolean | undefined
  machineOutput: boolean
  /** The command to name in the refusal, e.g. `kanbo init --global`. */
  command: string
}): Promise<boolean> {
  const print = input.machineOutput ? console.error : console.log
  print(input.preview)
  if (input.yes) {
    return true
  }
  if (!canPrompt()) {
    throw new CliError(1, `Nothing was changed. Run ${input.command} again with --yes to do this without being asked.`)
  }
  return await getUi().confirm({ message: input.question })
}

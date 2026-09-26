import { CliError } from '../output'

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
  if (!isInteractive()) {
    throw new CliError(1, `Nothing was changed. Run ${input.command} again with --yes to do this without being asked.`)
  }
  const prompts = await import('@clack/prompts')
  const answer = await prompts.confirm({ message: input.question })
  return answer === true
}

/** Is there a person on the other end of this shell to ask? */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY)
}

import { Command } from 'commander'

import { KANBO_PACKAGE_VERSION } from '../package-version'
import { registerKanboCommands } from './commands'
import { runBareKanbo } from './home'
import { canPrompt } from './ui/environment'
import { getUi } from './ui/ui'

/**
 * The `kanbo` program: every command on one `Command`, and what `kanbo` with
 * no words does.
 *
 * Its own module rather than part of `cli/index.ts`, which runs on import:
 * the home screen builds a fresh program for each command it runs from its
 * menu, and a test runs `kanbo …` in-process through `runKanbo`.
 */
export function createKanboProgram(): Command {
  const program = new Command()
    .name('kanbo')
    .description('A board for people and their agents, from a terminal. Reads and writes the board directly; no server needed.')
    .version(KANBO_PACKAGE_VERSION)
  registerKanboCommands(program)
  return program
}

/**
 * `kanbo` with these words. No words at all is the router (`home.ts`): the
 * init wizard, the home screen, or — with nobody to ask — a short hint.
 * Anything else is commander's, so an unknown word keeps its "unknown command"
 * error and suggestion, and `--help` its help.
 */
export async function runKanbo(args: string[], program: () => Command = createKanboProgram): Promise<void> {
  if (args.length === 0) {
    await runBareKanbo({
      ui: getUi(),
      interactive: canPrompt(),
      createProgram: () => program().exitOverride(),
      updateNotice: null,
    })
    return
  }
  await program().parseAsync(args, { from: 'user' })
}

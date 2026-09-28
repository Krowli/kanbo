import { Command } from 'commander'

import { KANBO_PACKAGE_VERSION } from '../package-version'
import type { KanboProgramContext } from './commands'
import { registerKanboCommands } from './commands'
import type { BareKanboContext } from './home'
import { runBareKanbo } from './home'
import { canPrompt } from './ui/environment'
import { getUi } from './ui/ui'
import type { InstallKind, UpdateCheckDeps, UpdateInstaller } from './update-check'
import { canUpdateInPlace, describeUpdateLine, installUpdate, offerUpdate, readInstallKind, skipsUpdateCheck, startUpdateCheck, UPDATE_COMMANDS } from './update-check'

/**
 * The `kanbo` program: every command on one `Command`, and what `kanbo` with
 * no words does.
 *
 * Its own module rather than part of `cli/index.ts`, which runs on import:
 * the home screen builds a fresh program for each command it runs from its
 * menu, and a test runs `kanbo …` in-process through `runKanbo`.
 */
export function createKanboProgram(context: KanboProgramContext = {}): Command {
  const program = new Command()
    .name('kanbo')
    .description('kanbo — a kanban board your coding agents work on and you approve. Run `kanbo` to start.')
    .version(KANBO_PACKAGE_VERSION)
  registerKanboCommands(program, context)
  return program
}

/** What the update check runs on, for a test: npm, the clock, the environment, the installer, the OS, how kanbo was installed. */
export interface UpdateRunOptions extends UpdateCheckDeps {
  install?: UpdateInstaller
  platform?: NodeJS.Platform
  installKind?: InstallKind
}

/**
 * `kanbo` with these words. No words at all is the router (`home.ts`): the
 * init wizard, the home screen, or — with nobody to ask — a short hint.
 * Anything else is commander's, so an unknown word keeps its "unknown command"
 * error and suggestion, and `--help` its help.
 *
 * Alongside the command, npm is asked whether a newer kanbo is out
 * (`update-check.ts`) — once per run: `kanbo doctor`, including every doctor
 * the home menu runs, reports this same check. The answer is used only once
 * the command has finished, and a command that fails ends without it. After
 * `kanbo doctor` nobody is asked (it showed the answer as a finding); after
 * the home screen the answer is one line, unless kanbo was updated from its menu.
 */
export async function runKanbo(
  args: string[],
  program: (context: KanboProgramContext) => Command = createKanboProgram,
  home: Pick<BareKanboContext, 'boardPage'> = {},
  updates: UpdateRunOptions = {},
): Promise<void> {
  const check = skipsUpdateCheck(args, updates.env) ? null : startUpdateCheck(updates)
  const context: KanboProgramContext = { update: check }
  const platform = updates.platform ?? process.platform
  const kind = updates.installKind ?? readInstallKind({ platform })
  const ui = getUi()
  const interactive = canPrompt(ui)
  let fromHome = false
  let told = false
  try {
    if (args.length === 0) {
      fromHome = await runBareKanbo({
        ui,
        interactive,
        createProgram: () => throwInsteadOfExiting(program(context)),
        ...(check
          ? {
              update: {
                peek: check.peek,
                inPlace: canUpdateInPlace(platform) && kind === 'global',
                command: UPDATE_COMMANDS[kind],
                install: () => {
                  // Tried from the menu: its outcome has been said, so nothing is said again on leaving.
                  told = true
                  return installUpdate(updates.install)
                },
                tell: (update) => {
                  told = true
                  console.error(describeUpdateLine(update, platform, kind))
                },
              },
            }
          : {}),
        ...home,
      }) === 'home'
    }
    else {
      await program(context).parseAsync(args, { from: 'user' })
    }
  }
  catch (error) {
    void check?.settle(0)
    throw error
  }
  const update = await check?.settle()
  if (!update || told || args[0] === 'doctor') {
    return
  }
  if (fromHome) {
    // The person has left the menu: no question now, one line.
    console.error(describeUpdateLine(update, platform, kind))
    return
  }
  await offerUpdate(update, { ui, interactive, install: updates.install, platform, kind })
}

/**
 * A program that throws where commander would end the process: the home menu
 * runs one on each item, and a mistake inside an item — a missing argument, an
 * unknown option of a subcommand — has to come back to the menu, not end kanbo.
 *
 * Every command in the tree gets it, with the program's own output settings:
 * commander copies both into a subcommand only when it is created, and these
 * commands were registered before this is called.
 */
function throwInsteadOfExiting(program: Command): Command {
  const output = program.configureOutput()
  const apply = (command: Command): void => {
    command.exitOverride().configureOutput(output)
    command.commands.forEach(apply)
  }
  apply(program)
  return program
}

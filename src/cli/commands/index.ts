import type { Command } from 'commander'

import type { UpdateCheck } from '../update-check'

import { registerApproveCommand } from './approve'
import { registerBoardCommand } from './board'
import { registerCapabilitiesCommand } from './capabilities'
import { registerCardCommands } from './card'
import { registerColumnsCommands } from './columns'
import { registerConnectCommand } from './connect'
import { registerDoctorCommand } from './doctor'
import { registerInitCommand } from './init'
import { registerInstructionsCommand } from './instructions'
import { registerMcpCommand } from './mcp'
import { registerMigrateCommand } from './migrate'
import { registerPrimeCommand } from './prime'
import { registerReadyCommand } from './ready'
import { registerReturnCommand } from './return'
import { registerRolesCommands } from './roles'
import { registerRunCommands } from './run'
import { registerServeCommand } from './serve'
import { registerSprintCommands } from './sprint'
import { registerUninstallCommand } from './uninstall'

/**
 * Every command the `kanbo` binary answers to, put on one program.
 *
 * It is its own module because more than one caller needs the list:
 * `cli/program.ts`, which builds the binary's program (and a fresh one for
 * each command the home screen runs from its menu), and `mcp/docs.test.ts`,
 * which walks the program to check that every command has a row in the docs
 * — a check that is worth nothing if the list it walks is a second copy of
 * this one.
 *
 * The order is the order `kanbo --help` lists them in, under the heading of
 * the group each belongs to.
 */
export function registerKanboCommands(program: Command, context: KanboProgramContext = {}): void {
  program.commandsGroup('Get started:')
  registerInitCommand(program)
  registerConnectCommand(program)
  registerInstructionsCommand(program)
  registerDoctorCommand(program, context.update ?? null)
  registerUninstallCommand(program)

  program.commandsGroup('Your board:')
  registerBoardCommand(program)
  registerCardCommands(program)
  registerColumnsCommands(program)
  registerApproveCommand(program)
  registerReturnCommand(program)
  registerReadyCommand(program)
  registerPrimeCommand(program)
  registerSprintCommands(program)
  registerServeCommand(program)

  program.commandsGroup('For agents and integrations:')
  registerMcpCommand(program)
  registerRunCommands(program)
  registerCapabilitiesCommand(program)

  program.commandsGroup('Shared Postgres boards:')
  registerMigrateCommand(program)
  registerRolesCommands(program)
}

/** What a run of `kanbo` hands its commands. */
export interface KanboProgramContext {
  /**
   * The update check this run started (`update-check.ts`), for `kanbo doctor`
   * to report instead of asking npm a second time; `null` or absent when the
   * run skips it.
   */
  update?: UpdateCheck | null
}

import type { Command } from 'commander'

import { registerApproveCommand } from './approve'
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
 */
export function registerKanboCommands(program: Command): void {
  registerInitCommand(program)
  registerConnectCommand(program)
  registerInstructionsCommand(program)
  registerDoctorCommand(program)
  registerUninstallCommand(program)
  registerCapabilitiesCommand(program)
  registerPrimeCommand(program)
  registerReadyCommand(program)
  registerColumnsCommands(program)
  registerCardCommands(program)
  registerApproveCommand(program)
  registerReturnCommand(program)
  registerRunCommands(program)
  registerSprintCommands(program)
  registerMigrateCommand(program)
  registerRolesCommands(program)
  registerMcpCommand(program)
  registerServeCommand(program)
}

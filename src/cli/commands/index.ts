import type { Command } from 'commander'

import type { UpdateCheck } from '../update-check'

import { registerApproveCommand } from './approve'
import { registerBoardCommand } from './board'
import { registerColumnsCommands } from './columns'
import { registerConnectCommand } from './connect'
import { registerDoctorCommand } from './doctor'
import { registerInitCommand } from './init'
import { registerMcpCommand } from './mcp'
import { registerMigrateCommand } from './migrate'
import { registerReturnCommand } from './return'
import { registerRolesCommands } from './roles'
import { registerServeCommand } from './serve'
import { registerSprintCommands } from './sprint'
import { registerStatsCommand } from './stats'
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
 * the group each belongs to. Agents reach the board through the MCP server
 * (`kanbo mcp`) alone; every other command is a person's.
 */
export function registerKanboCommands(program: Command, context: KanboProgramContext = {}): void {
  program.commandsGroup('Get started:')
  registerInitCommand(program)
  registerConnectCommand(program)
  registerDoctorCommand(program, context.update ?? null)
  registerUninstallCommand(program)

  program.commandsGroup('Your board:')
  registerBoardCommand(program)
  registerColumnsCommands(program)
  registerApproveCommand(program)
  registerReturnCommand(program)
  registerSprintCommands(program)
  registerStatsCommand(program)
  registerServeCommand(program)

  program.commandsGroup('For agents:')
  registerMcpCommand(program)

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

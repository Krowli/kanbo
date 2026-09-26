import type { Command } from 'commander'

import { registerApproveCommand } from './approve'
import { registerCapabilitiesCommand } from './capabilities'
import { registerCardCommands } from './card'
import { registerColumnsCommands } from './columns'
import { registerInitCommand } from './init'
import { registerMcpCommand } from './mcp'
import { registerMigrateCommand } from './migrate'
import { registerPrimeCommand } from './prime'
import { registerReadyCommand } from './ready'
import { registerReturnCommand } from './return'
import { registerRolesCommands } from './roles'
import { registerRunCommands } from './run'
import { registerServeCommand } from './serve'
import { registerSprintCommands } from './sprint'

/**
 * Every command the `kanbo` binary answers to, put on one program.
 *
 * It is its own module rather than a block inside `cli/index.ts` because two
 * callers need it and only one of them wants the binary: `index.ts` runs
 * `main()` on import, so a test that imported it would parse `process.argv`.
 * The other caller is `mcp/docs.test.ts`, which walks the program to check that
 * every command has a row in the README — a check that is worth nothing if the
 * list it walks is a second copy of this one.
 */
export function registerKanboCommands(program: Command): void {
  registerInitCommand(program)
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

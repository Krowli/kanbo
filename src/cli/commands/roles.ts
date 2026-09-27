import type { Command } from 'commander'

import { maskDatabaseUrl } from '../../domain/database-url'
import { BOARD_AGENT_ROLE, BOARD_PERSON_ROLE, BOARD_ROLE_SQL } from '../../postgres/roles.sql'
import type { BoardTargetCommandOptions } from '../command'
import { withTargetOptions } from '../command'
import { resolveDbTarget } from '../db-target'
import { CliError, printResult, readFormat } from '../output'
import { openPostgresBoard } from '../postgres-board'

/**
 * `kanbo roles` — the two roles an external board is worked through, and the
 * rules the database itself keeps about them.
 *
 * Two commands rather than one because applying them is a privileged act: the
 * SQL creates roles and triggers, which needs the owner of the board's tables,
 * and plenty of databases are administered by someone who will never run this
 * tool. `print` hands them the script to read and to apply themselves; `apply`
 * runs it for whoever already holds the owner's connection string.
 *
 * No password is ever accepted here, on the command line or anywhere else. A
 * password on a command line is in the shell's history and in the process list
 * of every other user on the machine, and the one place it belongs is the
 * `alter role` an administrator types themselves.
 *
 * `apply` is the owner's command, so it always resolves the board's own
 * connection string and never the agent's, whatever shell it is run from — the
 * role being configured cannot be the role doing the configuring. `print`
 * resolves nothing at all and therefore takes no options: it is one constant,
 * on stdout, for a person to read or redirect into `psql`.
 */

/** What a person is told when there is no external board to apply the roles to. */
export const ROLES_NEED_A_DATABASE_MESSAGE
  = 'The board roles are for a shared Postgres board. A board file is protected by whoever can open it — '
    + 'pass --database-url or set KANBO_DATABASE_URL.'

export function registerRolesCommands(program: Command): void {
  const roles = program
    .command('roles')
    .description('Set up the Postgres logins that keep agents from approving their own work')

  roles
    .command('print')
    .description('Print the SQL that creates the logins and their rights')
    .action(() => {
      console.log(BOARD_ROLE_SQL)
    })

  withTargetOptions(roles
    .command('apply')
    .description('Run that SQL on the shared board, as its owner'))
    .action(async (options: BoardTargetCommandOptions) => {
      readFormat(options)
      const target = resolveDbTarget({
        explicitPath: options.db,
        explicitUrl: options.databaseUrl,
        asAgent: false,
      })
      if (target.kind !== 'postgres') {
        throw new CliError(1, ROLES_NEED_A_DATABASE_MESSAGE)
      }

      const board = await openPostgresBoard(target.url)
      try {
        // Written to be run again: every role is created only if it is missing
        // and every trigger is replaced, so this is how the rules are updated too.
        await board.runScript(BOARD_ROLE_SQL)
      }
      finally {
        await board.close()
      }

      const database = maskDatabaseUrl(target.url)
      printResult({
        value: { database, roles: [BOARD_PERSON_ROLE, BOARD_AGENT_ROLE] },
        text: describeApplied(database),
      }, options)
    })
}

/**
 * What is left to do, said where the person is standing. The roles can log in
 * and have no password at all, which is not a state to leave a shared database
 * in and not one this tool can fix for them.
 */
function describeApplied(database: string): string {
  return [
    `Applied the board roles to ${database} — ${BOARD_PERSON_ROLE} and ${BOARD_AGENT_ROLE}.`,
    '',
    'Both were created with login and no password. Set one before handing out a connection string:',
    `  alter role ${BOARD_AGENT_ROLE} with password '…';`,
    `  alter role ${BOARD_PERSON_ROLE} with password '…';`,
    '',
    `A session must connect AS the role: the rules read current_user, so a login merely granted membership in `
    + `${BOARD_AGENT_ROLE} keeps its own name and none of them fires.`,
  ].join('\n')
}

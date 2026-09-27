import type { Command } from 'commander'

import { maskDatabaseUrl } from '../../domain/database-url'
import { migrateBoardFile } from '../../sqlite/migrate'
import { openBoardDatabase } from '../../sqlite/open-database'
import type { BoardTargetCommandOptions } from '../command'
import { withTargetOptions } from '../command'
import type { BoardTarget } from '../db-target'
import { resolveDbTarget } from '../db-target'
import { CliError, printResult, readFormat } from '../output'
import { openPostgresBoard } from '../postgres-board'

/**
 * `kanbo migrate` — creating the board in a database that has none, and
 * bringing one that has an older board up to date.
 *
 * It exists for the two homes this package owns: an external board, which has
 * no other owner at all, and a board file of a project's own, which this
 * package builds and this package alone keeps current (ruling 5-5). A host app's
 * own database is neither — its schema is the app's, and the app migrates it —
 * so this command refuses to touch it.
 *
 * It is the owner's command, so against an external board it always resolves
 * the board's own connection string and never the agent's, whatever shell it
 * is run from: `kanban_agent` may not create a table, and an administrator who
 * happens to be standing in an agent's shell would get a permission
 * error instead of a migration.
 */

/** What a person is told when they point this at a host app's own database file. */
export const BOARD_FILE_NOT_MIGRATED_MESSAGE
  = 'This database file belongs to the app the board lives in, and that app updates it. Pass --database-url, set '
    + 'KANBO_DATABASE_URL, or point --db at this project\'s own board file (kanbo init --file).'

export function registerMigrateCommand(program: Command): void {
  withTargetOptions(program
    .command('migrate')
    .description('create or update the board schema in an external Postgres database, or a board file of its own'))
    .action(async (options: BoardTargetCommandOptions) => {
      readFormat(options)
      const target = resolveDbTarget({
        explicitPath: options.db,
        explicitUrl: options.databaseUrl,
        asAgent: false,
      })
      if (target.kind === 'sqlite') {
        await migrateOwnFile(target, options)
        return
      }

      const board = await openPostgresBoard(target.url)
      try {
        // Drizzle keeps what it applied in `__drizzle_migrations`, which is
        // what makes running this again say the same thing and change nothing.
        await board.migrate()
      }
      finally {
        await board.close()
      }

      const database = maskDatabaseUrl(target.url)
      printResult({ value: { database }, text: `The board schema is up to date — ${database}` }, options)
    })
}

/**
 * Migrate a board file — this package's own chain, and only on a file this
 * package created in the first place. A host app's database carries no such
 * marker and is refused: `kanbo migrate` is never how an app's own database
 * gets its schema.
 */
async function migrateOwnFile(
  target: Extract<BoardTarget, { kind: 'sqlite' }>,
  options: BoardTargetCommandOptions,
): Promise<void> {
  if (target.owner !== 'kanbo') {
    throw new CliError(1, BOARD_FILE_NOT_MIGRATED_MESSAGE)
  }

  const board = await openBoardDatabase(target.path)
  try {
    // Drizzle's own migrator, same as `kanbo init --file`: idempotent by
    // `__drizzle_migrations`, so running this again says the same thing.
    migrateBoardFile(board.database)
  }
  finally {
    board.close()
  }

  printResult({
    value: { database: target.path },
    text: `The board schema is up to date — ${target.path}`,
  }, options)
}

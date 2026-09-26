import { BoardError } from '../domain/errors'
import type { BoardPostgresDatabase } from '../postgres/open-database'
import { assertBoardSchema as assertPostgresBoardSchema } from '../postgres/open-database'
import type { BoardFileOwner } from '../sqlite/open-database'
import { assertBoardSchema } from '../sqlite/open-database'
import type { SqliteDatabase } from '../sqlite/transaction'
import { CliError, EXIT_SCHEMA_OUTDATED } from './output'

export const SCHEMA_OUTDATED_MESSAGE
  = 'This database is older than the board schema. Let the app it belongs to apply its migrations first.'

/** The same, for a board file this package created and migrates itself. */
export const FILE_SCHEMA_OUTDATED_MESSAGE
  = 'Board file is older than this build. Run kanbo migrate.'

export const SCHEMA_NOT_INSTALLED_MESSAGE
  = 'This database holds no board this build can speak for — it has none, or one an '
    + 'older kanbo created. Run kanbo migrate.'

/**
 * Refuse to write to a board file this build cannot speak for.
 *
 * Which remedy a caller is told about depends on who migrates the file: a host
 * app migrates its own database, so an outdated one is read from at the
 * caller's own risk but never written to — a write shaped by this build's idea
 * of the schema is how a person's board gets a column full of nothing. A file
 * of this package's own is this package's to migrate, so the same refusal
 * points at `kanbo migrate` instead of at the app. Reads stay open either way,
 * because a person who cannot migrate right now should still be able to look at
 * their cards.
 */
export function assertWritableBoard(database: SqliteDatabase, owner: BoardFileOwner): void {
  try {
    assertBoardSchema(database)
  }
  catch (error) {
    if (error instanceof BoardError && error.code === 'board_schema_outdated') {
      throw new CliError(EXIT_SCHEMA_OUTDATED, owner === 'kanbo' ? FILE_SCHEMA_OUTDATED_MESSAGE : SCHEMA_OUTDATED_MESSAGE)
    }
    throw error
  }
}

/**
 * Refuse an external board this build cannot speak for — before reading it as
 * well as before writing to it.
 *
 * The asymmetry with the file above is the ownership. Nobody but this package
 * ever creates these tables, so a database with no board in it is not an older
 * board to be read carefully: it is a connection string pointing at something
 * else entirely, and reading eight tables that are not there says less than
 * naming the one command that would put them there. The same sentence answers
 * a board of another generation, which `kanbo migrate` also settles.
 */
export async function assertInstalledBoard(database: BoardPostgresDatabase): Promise<void> {
  try {
    await assertPostgresBoardSchema(database)
  }
  catch (error) {
    if (error instanceof BoardError && error.code === 'board_schema_outdated') {
      throw new CliError(EXIT_SCHEMA_OUTDATED, SCHEMA_NOT_INSTALLED_MESSAGE)
    }
    throw error
  }
}

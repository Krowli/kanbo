/**
 * The board schema generation this build of the package speaks. A database
 * stamped with anything else was written by another version, and the migration
 * that would bring it forward belongs to whoever owns the database — never to a
 * reader.
 *
 * The number says nothing about which engine holds the board: a SQLite file and
 * a Postgres database at the same epoch carry the same logical schema, which is
 * why a change to one is only ever made together with the same change to the
 * other.
 */
export const BOARD_SCHEMA_EPOCH = 1

/**
 * The tables a migration added to the board after epoch 1 was first written.
 *
 * A board that lacks one of these is not a database with no board in it — it
 * has every table the first migration made — but an older board of the same
 * epoch, which `kanbo migrate` (or, for a host app's own database, that app's migrations)
 * brings forward. `assertBoardSchema` names them apart from the founding tables
 * for exactly that reason: a host reads `missingTables` as "no board here" and
 * anything else as "an older board".
 */
export const BOARD_TABLES_ADDED_WITHIN_EPOCH = ['issue_pull_requests'] as const

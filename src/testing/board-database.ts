import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { sql } from 'drizzle-orm'

import { migrateBoardFile } from '../sqlite/migrate'
import type { BoardDatabase } from '../sqlite/open-database'
import { openBoardDatabase } from '../sqlite/open-database'

/** A board file a test owns: the open database, and the way to throw it away. */
export interface TestBoardDatabase extends BoardDatabase {
  /** The board file itself, for a test that opens a second connection onto it. */
  path: string
  /** Close the connection and delete the temporary directory holding the file. */
  dispose: () => void
}

/**
 * A real board file, migrated to the current schema by this package's own
 * migrations — the board and nothing else, the way `kanbo init --file` makes it.
 *
 * Board operations are mostly statements — numbering under a unique index,
 * window functions, `on conflict`, transactions and savepoints — so a fake store
 * would test the fake. Every test in the package therefore runs against SQLite
 * on disk rather than in memory: WAL, the busy timeout and two connections onto
 * one file only behave like themselves when the file exists.
 */
export async function createTestBoardDatabase(): Promise<TestBoardDatabase> {
  const directory = mkdtempSync(join(tmpdir(), 'kanbo-board-test-'))
  const path = join(directory, 'board.db')
  const board = await openBoardDatabase(path)
  migrateBoardFile(board.database)

  return {
    ...board,
    path,
    dispose: () => {
      board.close()
      rmSync(directory, { force: true, recursive: true })
    },
  }
}

/**
 * The workspace a test's cards hang off — which on a board of this package's
 * own is nothing at all.
 *
 * A board file holds the board and no `workspaces` table, and every reference
 * out of the board is a plain text column (ruling 5-1), so a workspace id is a
 * value the caller supplies rather than a row to point at. This exists so a
 * test written against both engines can say the same thing in both, and so the
 * difference is stated once, here, rather than as a missing call somewhere.
 */
export function seedWorkspace(_board: BoardDatabase, id: string, _identifier?: string): string {
  return id
}

/**
 * The one table of a host app's that the command line reads, in a board file
 * that does not have it.
 *
 * `kanbo --db <host.db>` resolves a workspace from the folder a command was
 * typed in, and in a host database the record of which folder is which
 * workspace is the app's `workspaces` row. That is a table this package never creates and never writes
 * to — it is read, by raw SQL, and by nothing else — so a test about that
 * lookup has to stand the table up itself. The columns are the four the adapter
 * selects; the rest of the app's row is not this package's business.
 */
export function seedHostWorkspace(
  board: BoardDatabase,
  id: string,
  identifier = id.slice(0, 3).toUpperCase(),
): void {
  board.database.run(sql`
    create table if not exists workspaces (
      id text primary key not null,
      name text not null,
      identifier text not null default '',
      locator_json text not null
    )
  `)
  // The locator is the app's own column, but the command line reads it: a
  // workspace is resolved from the folder the command was typed in, and only a
  // locator naming this node counts. A seeded workspace therefore says `local`,
  // so a test that does not pass `--workspace` resolves the same way a shell
  // would.
  const locatorJson = JSON.stringify({ nodeId: 'local', path: `/tmp/${id}` })
  board.database.run(sql`
    insert or replace into workspaces (id, name, identifier, locator_json)
    values (${id}, ${id}, ${identifier}, ${locatorJson})
  `)
}

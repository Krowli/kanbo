import { existsSync } from 'node:fs'

import type { BoardStore } from '../../board-store'
import { BoardError } from '../../domain/errors'
import { createPostgresBoardStore } from '../../postgres/board-store.postgres'
import { assertBoardSchema as assertPostgresBoardSchema } from '../../postgres/open-database'
import { createSqliteBoardStore } from '../../sqlite/board-store.sqlite'
import { assertBoardSchema, openBoardDatabase } from '../../sqlite/open-database'
import { openPostgresBoard } from '../postgres-board'

/**
 * What a board already holds for one workspace, before `kanbo init` asks
 * about it: a shared board another project member set up, or a board file
 * that is there without a binding.
 *
 * Neither keeps a workspaces table, so the card key is read where it is
 * written down for good — in the ids of the cards themselves (`WST-012` →
 * `WST`), the newest one, since a key changed later numbers the cards after it.
 */
export interface ExistingWorkspace {
  /** What this workspace's cards are numbered with; `null` when it has none yet. */
  key: string | null
  hasColumns: boolean
  /** Its columns' names, in board order. */
  columnNames: string[]
}

export async function readExistingWorkspace(store: BoardStore, workspaceId: string): Promise<ExistingWorkspace> {
  const [columns, newestNumber] = await Promise.all([
    store.statuses.listByWorkspace(workspaceId),
    store.issues.maxNumber(workspaceId),
  ])
  const newest = newestNumber > 0 ? await store.issues.findByNumber(workspaceId, newestNumber) : null
  const dash = newest ? newest.id.lastIndexOf('-') : -1
  return {
    key: newest && dash > 0 ? newest.id.slice(0, dash) : null,
    hasColumns: columns.length > 0,
    columnNames: columns.map(column => column.name),
  }
}

/** The same, on a shared Postgres board; `null` when its tables are not there yet. */
export async function inspectPostgresWorkspace(url: string, workspaceId: string): Promise<ExistingWorkspace | null> {
  const board = await openPostgresBoard(url)
  try {
    if (!await holdsCurrentBoard(() => assertPostgresBoardSchema(board.database))) {
      return null
    }
    return await readExistingWorkspace(createPostgresBoardStore({ database: board.database }), workspaceId)
  }
  finally {
    await board.close()
  }
}

/** The same, in a board file; `null` when there is no file there, or one this build would first migrate. */
export async function inspectBoardFile(path: string, workspaceId: string): Promise<ExistingWorkspace | null> {
  if (!existsSync(path)) {
    return null
  }
  const board = await openBoardDatabase(path)
  try {
    if (!await holdsCurrentBoard(() => assertBoardSchema(board.database))) {
      return null
    }
    return await readExistingWorkspace(createSqliteBoardStore({ database: () => board.database }), workspaceId)
  }
  finally {
    board.close()
  }
}

/** Does the schema guard pass? An outdated or missing board is not an error here: there is simply nothing to read yet. */
async function holdsCurrentBoard(guard: () => void | Promise<void>): Promise<boolean> {
  try {
    await guard()
    return true
  }
  catch (error) {
    if (error instanceof BoardError && error.code === 'board_schema_outdated') {
      return false
    }
    throw error
  }
}

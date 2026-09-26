import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { writeBinding } from '../cli/binding'
import type { BoardWorkspaceIdentity } from '../domain/numbering'
import type { BoardActor } from '../ops/types'
import { migrateBoardFile } from '../sqlite/migrate'
import { markBoardFileOwnedByKanbo, openBoardDatabase } from '../sqlite/open-database'
import { createDbTransport } from './db-transport'

/**
 * `kanbo mcp` against a board file of this project's own.
 *
 * `db-transport.ts` calls exactly the same `openBoardSession` every `kanbo`
 * command opens its board through, so this checks only what is different for
 * an own file rather than re-running the whole tool surface `tools.test.ts`
 * already covers against a host database: the workspace comes off
 * the binding, and a card is still numbered and moved through it.
 */

const WORKSPACE: BoardWorkspaceIdentity = { id: 'proj', identifier: 'PRJ', name: 'PRJ' }
const ACTOR: BoardActor = { kind: 'external', id: 'tester' }

describe('kanbo mcp on a board file of its own', () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'kanbo-mcp-file-'))
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir)
    for (const name of ['KANBO_DB_PATH', 'KANBO_WORKSPACE_ID', 'KANBO_DATABASE_URL']) {
      vi.stubEnv(name, undefined)
    }
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    rmSync(projectDir, { force: true, recursive: true })
  })

  it('creates, lists and moves a card using the workspace the binding names', async () => {
    const dbPath = join(projectDir, '.kanbo', 'board.db')
    mkdirSync(dirname(dbPath), { recursive: true })
    const board = await openBoardDatabase(dbPath)
    migrateBoardFile(board.database)
    markBoardFileOwnedByKanbo(board.database)
    board.close()
    writeBinding(projectDir, {
      schemaVersion: 1,
      workspaceId: WORKSPACE.id,
      boardId: null,
      dbPath: join('.kanbo', 'board.db'),
      identifier: WORKSPACE.identifier,
    })

    const transport = await createDbTransport({ dbPath, actor: ACTOR })
    try {
      const created = await transport.cardCreate({ title: 'Card' })
      expect(created.id).toBe('PRJ-001')

      const moved = await transport.cardMove({ card: created.id, column: 'in_progress' })
      expect(moved.columnSlug).toBe('in_progress')

      const listed = await transport.cardList({})
      expect(listed.map(card => card.id)).toEqual(['PRJ-001'])
    }
    finally {
      await transport.close()
    }
  })
})

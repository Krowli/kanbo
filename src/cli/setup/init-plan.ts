import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, relative } from 'node:path'

import type { BoardWorkspaceIdentity } from '../../domain/numbering'
import { createBoardOps } from '../../ops'
import { createSqliteBoardStore } from '../../sqlite/board-store.sqlite'
import { migrateBoardFile } from '../../sqlite/migrate'
import type { BoardFileContents } from '../../sqlite/open-database'
import { markBoardFileOwnedByKanbo, openBoardDatabase, readBoardFileContents } from '../../sqlite/open-database'
import type { KanboBinding } from '../binding'
import { BINDING_FILE_PATH, ignoreBoardFile, writeBinding } from '../binding'
import type { BoardTarget } from '../db-target'
import { CliError } from '../output'
import type { FileChange, FileOutcome } from './file-change'
import { applyFileChange } from './file-change'
import { renameWithRetry } from './fs-retry'

/**
 * What `kanbo init` is about to do to a project, worked out in full before
 * anything is written.
 *
 * `init` resolves its inputs and asks its questions first, builds this plan,
 * shows it to a person at a terminal and asks once, and only then applies it.
 * Stopping at any question — Ctrl-C included — leaves the folder exactly as it
 * was: not even the binding is written before the plan is applied.
 */
export interface InitPlan {
  projectDir: string
  target: BoardTarget
  workspace: BoardWorkspaceIdentity
  /** What `.kanbo/binding.json` says afterwards. */
  binding: KanboBinding
  /** A board file of the project's own to create, or to migrate when it is already there. */
  boardFile: { path: string, exists: boolean } | null
  /** Seed the standard columns into a board file created here, so `kanbo prime` has them from the start. */
  columns?: 'default'
  /** The agent files, each worked out already; one that already says it has `next: null`. */
  fileChanges: InitFileChange[]
}

export interface InitFileChange {
  kind: 'instructions' | 'mcp'
  change: FileChange
}

export interface AppliedInitPlan {
  bindingPath: string
  files: (FileOutcome & { kind: InitFileChange['kind'] })[]
}

/** Refuse a board file already at this path that this package did not write — before any question is asked. */
export function assertOwnBoardFile(absolutePath: string): void {
  let contents: BoardFileContents
  try {
    contents = readBoardFileContents(absolutePath)
  }
  catch {
    throw new CliError(1, notABoardFileMessage(absolutePath))
  }
  if (!contents.empty && contents.owner !== 'kanbo') {
    throw new CliError(1, notABoardFileMessage(absolutePath))
  }
}

function notABoardFileMessage(absolutePath: string): string {
  return `${absolutePath} already holds a database of its own. Name another path with --file, `
    + 'or move that file out of the way.'
}

/** The plan as a person reads it before saying yes. */
export function describeInitPlan(plan: InitPlan): string {
  const lines = ['kanbo init will:']
  if (plan.boardFile) {
    const what = plan.boardFile.exists
      ? 'the board file of this project, brought up to date'
      : `a board file of this project's own${plan.columns ? ', with the standard columns' : ''}`
    lines.push(`  ${plan.boardFile.exists ? 'update' : 'create'}  ${relativeTo(plan, plan.boardFile.path)} (${what})`)
  }
  lines.push(`  write   ${BINDING_FILE_PATH} (binds this project to ${plan.workspace.name})`)
  for (const { kind, change } of plan.fileChanges) {
    if (change.next !== null) {
      lines.push(`  write   ${relativeTo(plan, change.path)} (${kind === 'instructions' ? 'the kanbo section for agents' : 'the kanbo MCP server'})`)
    }
  }
  lines.push('Nothing else is changed.')
  return lines.join('\n')
}

function relativeTo(plan: InitPlan, path: string): string {
  const inside = relative(plan.projectDir, path)
  return inside.startsWith('..') ? path : inside
}

/**
 * Carry the plan out: the board file first, so a migration that fails leaves
 * no binding pointing at nothing; then the binding; then the agent files.
 */
export async function applyInitPlan(plan: InitPlan): Promise<AppliedInitPlan> {
  if (plan.boardFile) {
    await createOwnBoardFile(plan.boardFile.path, plan.columns ? plan.workspace.id : null)
    ignoreBoardFile(plan.projectDir, plan.boardFile.path)
  }
  const bindingPath = writeBinding(plan.projectDir, plan.binding)
  const files = plan.fileChanges.map(({ kind, change }) => ({ kind, ...applyFileChange(change) }))
  return { bindingPath, files }
}

/**
 * Put a migrated, marked board at this path — or leave the folder exactly as it
 * was found (ruling 5-9).
 *
 * A new board is built beside its own path and moved onto it at the end, so a
 * migration that fails half-way leaves no half-built file for the next command
 * to open and believe in. `rename` within one directory is the filesystem's own
 * atomic swap; a temporary name elsewhere would be a copy across devices and
 * not atomic at all. A file that is already there may hold this project's
 * cards, so it is migrated in place, idempotently, which is what makes a second
 * `kanbo init --file` a no-op.
 *
 * The standard columns go into a new board before it is moved into place, for
 * `seedWorkspaceId`: `kanbo prime` right after `init` then has columns to show.
 */
async function createOwnBoardFile(absolutePath: string, seedWorkspaceId: string | null): Promise<void> {
  mkdirSync(dirname(absolutePath), { recursive: true })
  if (existsSync(absolutePath)) {
    assertOwnBoardFile(absolutePath)
    await migrateBoardFileAt(absolutePath, null)
    return
  }

  const temporaryPath = `${absolutePath}.${process.pid}.tmp`
  try {
    await migrateBoardFileAt(temporaryPath, seedWorkspaceId)
    renameWithRetry(temporaryPath, absolutePath)
  }
  catch (error) {
    // Its WAL siblings too: SQLite removes them on a clean close, and a close
    // is exactly what a failure half-way through may not have reached.
    for (const leftover of [temporaryPath, `${temporaryPath}-wal`, `${temporaryPath}-shm`]) {
      rmSync(leftover, { force: true })
    }
    throw error
  }
}

async function migrateBoardFileAt(path: string, seedWorkspaceId: string | null): Promise<void> {
  const board = await openBoardDatabase(path)
  try {
    migrateBoardFile(board.database)
    markBoardFileOwnedByKanbo(board.database)
    if (seedWorkspaceId) {
      await createBoardOps(createSqliteBoardStore({ database: () => board.database })).ensureDefaultColumns(seedWorkspaceId)
    }
  }
  finally {
    board.close()
  }
}

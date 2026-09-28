import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, relative } from 'node:path'

import type { ColumnSpec } from '../../domain/column-templates'
import { maskDatabaseUrl } from '../../domain/database-url'
import type { BoardWorkspaceIdentity } from '../../domain/numbering'
import type { BoardOps } from '../../ops'
import { createBoardOps } from '../../ops'
import { createPostgresBoardStore } from '../../postgres/board-store.postgres'
import { createSqliteBoardStore } from '../../sqlite/board-store.sqlite'
import { migrateBoardFile } from '../../sqlite/migrate'
import type { BoardFileContents } from '../../sqlite/open-database'
import { markBoardFileOwnedByKanbo, openBoardDatabase, readBoardFileContents } from '../../sqlite/open-database'
import { createPlacementActor } from '../actor'
import type { KanboBinding } from '../binding'
import { BINDING_FILE_PATH, ignoreBoardFile, writeBinding } from '../binding'
import type { BoardTarget } from '../db-target'
import { CliError } from '../output'
import { openPostgresBoard } from '../postgres-board'
import type { ConnectOutcome, ConnectPlan } from './connect-plan'
import { applyConnectPlan, displayPath, explainItem, itemPath, pendingItems } from './connect-plan'
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
  /**
   * The columns a new board starts with — a board file created here, or a
   * shared database whose tables are created here — so `kanbo prime` has them
   * from the start. `null` leaves the board's columns as they are.
   */
  columns: readonly ColumnSpec[] | null
  /** Create the board's tables in the shared Postgres database first, as `kanbo migrate` does. */
  migrate: boolean
  /** The agent files `--instructions`/`--mcp` asked for, each worked out already; one that already says it has `next: null`. */
  fileChanges: InitFileChange[]
  /** The agents `--connect` (or the wizard) connects, as `kanbo connect` would; `null` when none. */
  connect: ConnectPlan | null
  /** The title of a card to put in To Do once the board is there. */
  firstCard: string | null
  /**
   * What `--columns` and `--key` asked of a board that already has its own,
   * which it keeps — one sentence each, said rather than silently dropped.
   */
  kept: string[]
}

export interface InitFileChange {
  kind: 'instructions' | 'mcp'
  change: FileChange
}

export interface AppliedInitPlan {
  bindingPath: string
  files: (FileOutcome & { kind: InitFileChange['kind'] })[]
  connect: ConnectOutcome[]
  /** The columns put on the board, in order; empty when it kept the ones it had. */
  columns: string[]
  firstCard: { id: string, title: string } | null
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
  const columns = plan.columns ? `, with the columns ${plan.columns.map(column => column.name).join(', ')}` : ''
  if (plan.boardFile) {
    const what = plan.boardFile.exists
      ? 'the board file of this project, brought up to date'
      : `a board file of this project's own${columns}`
    lines.push(`  ${plan.boardFile.exists ? 'update' : 'create'}  ${relativeTo(plan, plan.boardFile.path)} (${what})`)
  }
  if (plan.target.kind === 'postgres' && plan.migrate) {
    lines.push(`  create  the board's tables in ${maskDatabaseUrl(plan.target.url)}${columns}`)
  }
  lines.push(`  write   ${BINDING_FILE_PATH} (binds this project to ${plan.workspace.name})`)
  for (const { kind, change } of plan.fileChanges) {
    if (change.next !== null) {
      lines.push(`  write   ${relativeTo(plan, change.path)} (${kind === 'instructions' ? 'the kanbo section for agents' : 'the kanbo MCP server'})`)
    }
  }
  for (const item of plan.connect ? pendingItems(plan.connect) : []) {
    lines.push(item.kind === 'claude-cli'
      ? `  run     ${explainItem(item)}`
      : `  write   ${displayPath(plan, itemPath(item))} (${explainItem(item)})`)
  }
  if (plan.firstCard) {
    lines.push(`  add     a first card to To Do: ${plan.firstCard}`)
  }
  for (const note of plan.connect?.notes ?? []) {
    lines.push(`Note: ${note}`)
  }
  lines.push('Nothing else is changed.')
  return lines.join('\n')
}

function relativeTo(plan: InitPlan, path: string): string {
  const inside = relative(plan.projectDir, path)
  return inside.startsWith('..') ? path : inside
}

/**
 * Carry the plan out: the board first — the file, or the shared database's
 * tables — so a migration that fails leaves no binding pointing at nothing;
 * then the binding; then the agent files; then the first card.
 */
export async function applyInitPlan(plan: InitPlan): Promise<AppliedInitPlan> {
  let columns: string[] = []
  if (plan.boardFile) {
    columns = await createOwnBoardFile(plan.boardFile.path, plan.columns ? { workspaceId: plan.workspace.id, columns: plan.columns } : null)
    ignoreBoardFile(plan.projectDir, plan.boardFile.path)
  }
  if (plan.target.kind === 'postgres' && plan.migrate) {
    columns = await migrateSharedBoard(plan.target.url, plan.workspace.id, plan.columns)
  }
  const bindingPath = writeBinding(plan.projectDir, plan.binding)
  const files = plan.fileChanges.map(({ kind, change }) => ({ kind, ...applyFileChange(change) }))
  const connect = plan.connect ? applyConnectPlan(plan.connect) : []
  const firstCard = plan.firstCard ? await addFirstCard(plan, plan.firstCard) : null
  return { bindingPath, files, connect, columns, firstCard }
}

/** Create or update the shared board's tables, and put the columns on a board that has none. */
async function migrateSharedBoard(url: string, workspaceId: string, columns: readonly ColumnSpec[] | null): Promise<string[]> {
  const board = await openPostgresBoard(url)
  try {
    await board.migrate()
    if (!columns) {
      return []
    }
    const ops = createBoardOps(createPostgresBoardStore({ database: board.database }))
    return (await ops.applyColumnTemplate(workspaceId, columns, { mode: 'seed' })).added
  }
  finally {
    await board.close()
  }
}

/** Put the first card in To Do — or in the board's first column, on a board that has no To Do. */
async function addFirstCard(plan: InitPlan, title: string): Promise<{ id: string, title: string }> {
  return await withBoardOps(plan.target, async (ops) => {
    const toDo = await ops.findColumn(plan.workspace.id, 'to_do')
    const card = await ops.createCard({ workspace: plan.workspace, title, ...(toDo ? { statusId: toDo.id } : {}) }, createPlacementActor())
    return { id: card.id, title: card.title }
  })
}

async function withBoardOps<T>(target: BoardTarget, body: (ops: BoardOps) => Promise<T>): Promise<T> {
  if (target.kind === 'postgres') {
    const board = await openPostgresBoard(target.url)
    try {
      return await body(createBoardOps(createPostgresBoardStore({ database: board.database })))
    }
    finally {
      await board.close()
    }
  }
  const board = await openBoardDatabase(target.path)
  try {
    return await body(createBoardOps(createSqliteBoardStore({ database: () => board.database })))
  }
  finally {
    board.close()
  }
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
 * The chosen columns go into a new board before it is moved into place, for
 * `seed`'s workspace: `kanbo prime` right after `init` then has columns to show.
 * Returns the names of the columns put there.
 */
async function createOwnBoardFile(absolutePath: string, seed: ColumnSeed | null): Promise<string[]> {
  mkdirSync(dirname(absolutePath), { recursive: true })
  if (existsSync(absolutePath)) {
    assertOwnBoardFile(absolutePath)
    return await migrateBoardFileAt(absolutePath, null)
  }

  const temporaryPath = `${absolutePath}.${process.pid}.tmp`
  try {
    const columns = await migrateBoardFileAt(temporaryPath, seed)
    renameWithRetry(temporaryPath, absolutePath)
    return columns
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

interface ColumnSeed {
  workspaceId: string
  columns: readonly ColumnSpec[]
}

async function migrateBoardFileAt(path: string, seed: ColumnSeed | null): Promise<string[]> {
  const board = await openBoardDatabase(path)
  try {
    migrateBoardFile(board.database)
    markBoardFileOwnedByKanbo(board.database)
    if (!seed) {
      return []
    }
    const ops = createBoardOps(createSqliteBoardStore({ database: () => board.database }))
    return (await ops.applyColumnTemplate(seed.workspaceId, seed.columns, { mode: 'seed' })).added
  }
  finally {
    board.close()
  }
}

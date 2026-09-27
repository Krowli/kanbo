import { randomUUID } from 'node:crypto'

import type { BoardStore } from '../board-store'
import type { ColumnSpec } from '../domain/column-templates'
import { READY_COLUMN_SLUG } from '../domain/column-templates'
import type { UnmetEntryRule } from '../domain/entry-rules'
import { serializeEntryRules } from '../domain/entry-rules'
import { BoardError } from '../domain/errors'
import { DEFAULT_STATUSES, normalizeStatusName } from '../domain/status-name'
import { currentUnixSeconds } from '../domain/time'
import type { Issue, IssueStatus, issueStatuses } from '../sqlite/schema'
import { bulkUpdateCards } from './card-batch'
import type { BoardWriteScope } from './change-seq'
import { runBoardWrite } from './change-seq'
import type { BoardActor } from './types'
import { BOARD_ACTOR } from './types'

/** What a column is made of, beyond the workspace it belongs to and its position. */
export interface BoardColumnInput {
  workspaceId: string
  name: string
  description?: string | null
  color?: string | null
  category?: IssueStatus['category']
  /** What a card must satisfy before an agent may put it here — `ENTRY_RULES`, none by default. */
  entryRules?: readonly string[] | null
}

/** What `updateColumn` may change about a column. */
export interface BoardColumnPatch {
  name?: string
  description?: string | null
  color?: string | null
  /** `ENTRY_RULES`; `null` or an empty list asks for nothing. */
  entryRules?: readonly string[] | null
}

/** The columns of one workspace, in board order. */
export async function listColumns(store: BoardStore, workspaceId: string): Promise<IssueStatus[]> {
  return await store.statuses.listByWorkspace(workspaceId)
}

/**
 * The column the caller named, by id or by any spelling of its name — `In
 * Progress`, `in-progress` and `IN_PROGRESS` all reach the same one. `null` when
 * the workspace holds no such column.
 */
export async function findColumn(store: BoardStore, workspaceId: string, nameOrId: string): Promise<IssueStatus | null> {
  const columns = await listColumns(store, workspaceId)
  const byId = columns.find(column => column.id === nameOrId)
  if (byId) {
    return byId
  }
  const slug = normalizeStatusName(nameOrId)
  if (!slug) {
    throw new BoardError('issue_status_name_empty', { workspaceId })
  }
  return columns.find(column => normalizeStatusName(column.name) === slug) ?? null
}

/** The column the caller named, or the error that says the board has no such column. */
export async function requireColumn(store: BoardStore, workspaceId: string, nameOrId: string): Promise<IssueStatus> {
  const column = await findColumn(store, workspaceId, nameOrId)
  if (!column) {
    throw new BoardError('issue_status_not_found', {
      workspaceId,
      statusName: nameOrId,
      normalizedStatusName: normalizeStatusName(nameOrId),
    })
  }
  return column
}

/**
 * The columns of the workspace, seeding the standard six the first time someone
 * looks. A board that already holds a column of its own is never seeded: those
 * columns are the user's data, and a workspace that was pruned down to one
 * column meant it.
 */
export async function ensureDefaultColumns<TStore extends BoardStore>(
  store: TStore,
  workspaceId: string,
  scope?: BoardWriteScope<TStore>,
): Promise<IssueStatus[]> {
  return (await applyColumnTemplate(store, workspaceId, DEFAULT_STATUSES, { mode: 'seed' }, scope)).statuses
}

/**
 * How `applyColumnTemplate` treats a board: `seed` fills an empty board and
 * leaves any other alone; `add-missing` adds the template's columns the board
 * lacks and keeps every column it has — a person's change to the board's
 * structure, so it names the person.
 */
export type ApplyColumnTemplateOptions
  = | { mode: 'seed' }
    | { mode: 'add-missing', actor: BoardActor }

/**
 * Put a set of columns — a template from `domain/column-templates.ts`, or one a
 * person put together — on a workspace's board, in the order given.
 *
 * `seed` writes only to a board with no columns yet, and reports what it added;
 * a board that has columns keeps them, untouched, and nothing is added.
 *
 * `add-missing` adds each column of the set the board does not have yet (by
 * slug), placed the way `addStandardColumns` places the standard ones; a board
 * that has them all is not written to. Only a person may ask for it.
 */
export async function applyColumnTemplate<TStore extends BoardStore>(
  store: TStore,
  workspaceId: string,
  columns: readonly ColumnSpec[],
  options: ApplyColumnTemplateOptions,
  scope?: BoardWriteScope<TStore>,
): Promise<{ statuses: IssueStatus[], added: string[] }> {
  if (options.mode === 'add-missing') {
    assertPersonChangesColumns(options.actor, { workspaceId })
    return await addMissingColumns(store, workspaceId, columns, scope)
  }

  if (await store.statuses.countByWorkspace(workspaceId) > 0) {
    return { statuses: await listColumns(store, workspaceId), added: [] }
  }

  return await runBoardWrite(store, async ({ tx }) => {
    // Another writer may have seeded the same workspace between the count above
    // and this transaction; the unique index on `(workspace_id, name)` would
    // then refuse the insert, so the count is taken again under the write lock.
    if (await tx.statuses.countByWorkspace(workspaceId) > 0) {
      return { statuses: await listColumns(tx, workspaceId), added: [] }
    }
    for (const [order, column] of columns.entries()) {
      await insertColumn(tx, { workspaceId, ...column }, order)
    }
    return { statuses: await listColumns(tx, workspaceId), added: columns.map(column => column.name) }
  }, scope)
}

/**
 * Only a person sets, changes or clears what a column asks of a card: an agent
 * that could clear a column's rules could walk any card past them.
 */
function assertPersonSetsEntryRules(actor: BoardActor, details: Record<string, unknown>): void {
  if (actor.kind !== 'user') {
    throw new BoardError('board_column_rules_requires_user', { ...details, actorKind: actor.kind })
  }
}

/**
 * Only a person renames, moves or removes a column, or adds a template's
 * columns: the board's structure is what every agent reads its work from.
 */
function assertPersonChangesColumns(actor: BoardActor, details: Record<string, unknown>): void {
  if (actor.kind !== 'user') {
    throw new BoardError('board_column_structure_requires_user', { ...details, actorKind: actor.kind })
  }
}

/**
 * Add a column at the end of the board. Only a person changes the board's
 * structure; an actor that is not one is refused before anything is written.
 * The name follows the rules `renameColumn` holds a new name to: not empty,
 * and no other column of the workspace answering to its slug.
 */
export async function createColumn<TStore extends BoardStore>(
  store: TStore,
  input: BoardColumnInput,
  actor: BoardActor,
  scope?: BoardWriteScope<TStore>,
): Promise<IssueStatus> {
  assertPersonChangesColumns(actor, { workspaceId: input.workspaceId, name: input.name })
  if (serializeEntryRules(input.entryRules ?? null) !== null) {
    assertPersonSetsEntryRules(actor, { workspaceId: input.workspaceId, name: input.name })
  }
  const name = requireColumnName(input.name, input.workspaceId)
  return await runBoardWrite(store, async ({ tx }) => {
    const columns = await listColumns(tx, input.workspaceId)
    assertNameFree(columns, null, name, input.workspaceId)
    // New columns land at the end of the board: one past the last, so a board
    // whose orders have gaps still gets a column no other shares.
    return await insertColumn(tx, { ...input, name }, nextOrder(columns))
  }, scope)
}

/**
 * Change a column's name, description, colour or entry rules.
 *
 * A new name is held to `renameColumn`'s rules — its slug is not another
 * column's, and To Do keeps the slug `to_do` — and a name that changes is a
 * change to the board's structure, a person's to make. Description and
 * colour stay open to anyone; entry rules are a person's.
 */
export async function updateColumn<TStore extends BoardStore>(
  store: TStore,
  statusId: string,
  patch: BoardColumnPatch,
  actor: BoardActor,
  scope?: BoardWriteScope<TStore>,
): Promise<IssueStatus> {
  // Checked before the write starts: an unknown rule, or an actor who is not a
  // person, changes nothing.
  const entryRules = 'entryRules' in patch ? serializeEntryRules(patch.entryRules ?? null) : undefined
  if (entryRules !== undefined) {
    assertPersonSetsEntryRules(actor, { statusId })
  }
  return await runBoardWrite(store, async ({ tx }) => {
    const current = await tx.statuses.findById(statusId)
    if (!current) {
      throw new BoardError('issue_status_not_found', { statusId })
    }
    const updates: Partial<typeof issueStatuses.$inferInsert> = {}
    if (patch.name !== undefined) {
      const name = requireColumnName(patch.name, current.workspaceId)
      if (name !== current.name) {
        assertPersonChangesColumns(actor, { workspaceId: current.workspaceId, statusName: current.name })
        assertRenameAllowed(await listColumns(tx, current.workspaceId), current, name)
        updates.name = name
      }
    }
    if ('description' in patch) {
      updates.description = patch.description ?? null
    }
    if ('color' in patch) {
      updates.color = patch.color ?? null
    }
    if (entryRules !== undefined) {
      updates.entryRules = entryRules
    }
    if (Object.keys(updates).length > 0) {
      await tx.statuses.update(statusId, updates)
    }
    return (await tx.statuses.findById(statusId))!
  }, scope)
}

/**
 * Give a column the one line that tells an agent when a card belongs in it. The
 * column is named the way a person would name it — by id, or by any spelling of
 * its name.
 */
export async function describeColumn<TStore extends BoardStore>(
  store: TStore,
  workspaceId: string,
  nameOrId: string,
  description: string | null,
  scope?: BoardWriteScope<TStore>,
): Promise<IssueStatus> {
  return await runBoardWrite(store, async ({ tx }) => {
    const column = await requireColumn(tx, workspaceId, nameOrId)
    return await updateColumn(tx, column.id, { description }, BOARD_ACTOR, { tx })
  }, scope)
}

/**
 * Set what a card must satisfy before an agent may put it in the column
 * (ruling 6-1): `ENTRY_RULES`, or `null` / an empty list for nothing. The column
 * is named the way `describeColumn` names it.
 */
export async function setColumnEntryRules<TStore extends BoardStore>(
  store: TStore,
  workspaceId: string,
  nameOrId: string,
  entryRules: readonly string[] | null,
  actor: BoardActor,
  scope?: BoardWriteScope<TStore>,
): Promise<IssueStatus> {
  serializeEntryRules(entryRules)
  assertPersonSetsEntryRules(actor, { workspaceId, statusName: nameOrId })
  return await runBoardWrite(store, async ({ tx }) => {
    const column = await requireColumn(tx, workspaceId, nameOrId)
    return await updateColumn(tx, column.id, { entryRules }, actor, { tx })
  }, scope)
}

/**
 * Take an empty column off the board, and number the columns left 0..n-1 in
 * the same write.
 *
 * To Do is never deleted (`kanbo ready` takes work from it), and neither is a
 * column that still holds cards: they would be left in no column. Move them
 * first, or use `removeColumn`, which moves them in the same write. With an
 * `actor` that is not a person the delete is refused before anything is read.
 */
export async function deleteColumn<TStore extends BoardStore>(
  store: TStore,
  statusId: string,
  scope?: BoardWriteScope<TStore>,
  actor?: BoardActor,
): Promise<void> {
  if (actor) {
    assertPersonChangesColumns(actor, { statusId })
  }
  await runBoardWrite(store, async ({ tx }) => {
    const column = await tx.statuses.lockById(statusId)
    if (!column) {
      throw new BoardError('issue_status_not_found', { statusId })
    }
    if (normalizeStatusName(column.name) === READY_COLUMN_SLUG) {
      throw new BoardError('board_column_ready_protected', { workspaceId: column.workspaceId, statusName: column.name })
    }
    const cardCount = (await cardsInColumn(tx, column)).length
    if (cardCount > 0) {
      throw new BoardError('board_column_not_empty', {
        workspaceId: column.workspaceId,
        statusName: column.name,
        cardCount,
        hint: 'Move its cards to another column first, or remove it with removeColumn and moveCardsTo.',
      })
    }
    await tx.statuses.delete(statusId)
    await renumberColumns(tx, column.workspaceId)
  }, scope)
}

/**
 * Put the workspace's columns in the given order; unnamed columns keep their
 * place. With an `actor` that is not a person nothing is written.
 */
export async function reorderColumns<TStore extends BoardStore>(
  store: TStore,
  workspaceId: string,
  orderedIds: string[],
  scope?: BoardWriteScope<TStore>,
  actor?: BoardActor,
): Promise<void> {
  if (actor) {
    assertPersonChangesColumns(actor, { workspaceId })
  }
  await runBoardWrite(store, async ({ tx }) => {
    for (const [order, statusId] of orderedIds.entries()) {
      await tx.statuses.update(statusId, { order })
    }
  }, scope)
}

/**
 * Bring a board that predates the standard set up to it, without touching the
 * columns its owner made.
 *
 * Each missing standard column goes directly after the nearest standard column
 * before it that the board already has — so `To Do` lands behind `Backlog` even
 * when the owner put three columns of their own in between — and at the front
 * when none of them is there. A board that already holds all six is left
 * untouched, down to the board version: running this twice must not look like a
 * change to anyone polling. With an `actor` that is not a person nothing is
 * written.
 */
export async function addStandardColumns<TStore extends BoardStore>(
  store: TStore,
  workspaceId: string,
  scope?: BoardWriteScope<TStore>,
  actor?: BoardActor,
): Promise<{ statuses: IssueStatus[], added: string[] }> {
  if (actor) {
    assertPersonChangesColumns(actor, { workspaceId })
  }
  return await addMissingColumns(store, workspaceId, DEFAULT_STATUSES, scope)
}

/**
 * Add the columns of `template` the board lacks, each directly after the
 * nearest template column before it that the board has (or at the front), and
 * leave every other column where it is. Nothing is written when none is missing.
 */
async function addMissingColumns<TStore extends BoardStore>(
  store: TStore,
  workspaceId: string,
  template: readonly ColumnSpec[],
  scope?: BoardWriteScope<TStore>,
): Promise<{ statuses: IssueStatus[], added: string[] }> {
  const present = await listColumns(store, workspaceId)
  const presentSlugs = new Set(present.map(column => normalizeStatusName(column.name)))
  const missing = template.filter(spec => !presentSlugs.has(normalizeStatusName(spec.name)))
  if (missing.length === 0) {
    return { statuses: present, added: [] }
  }

  return await runBoardWrite(store, async ({ tx }) => {
    // The board as it will look, template columns included, before anything is
    // written: inserting into this list is what decides the final order.
    const planned: PlannedColumn[] = present.map(column => ({ column }))

    for (const spec of missing) {
      planned.splice(placeAfterPrecedingTemplateColumn(planned, template, spec), 0, { spec })
    }

    const added: string[] = []
    for (const [order, entry] of planned.entries()) {
      if ('spec' in entry) {
        await insertColumn(tx, { workspaceId, ...entry.spec }, order)
        added.push(entry.spec.name)
        continue
      }
      if (entry.column.order !== order) {
        await tx.statuses.update(entry.column.id, { order })
      }
    }

    return { statuses: await listColumns(tx, workspaceId), added }
  }, scope)
}

type PlannedColumn = { column: IssueStatus } | { spec: ColumnSpec }

/** Where a missing template column goes: right after the last template column before it. */
function placeAfterPrecedingTemplateColumn(
  planned: PlannedColumn[],
  template: readonly ColumnSpec[],
  spec: ColumnSpec,
): number {
  const precedingSlugs = template
    .slice(0, template.indexOf(spec))
    .map(preceding => normalizeStatusName(preceding.name))

  for (const slug of precedingSlugs.toReversed()) {
    const index = planned.findIndex(entry => normalizeStatusName(
      'spec' in entry ? entry.spec.name : entry.column.name,
    ) === slug)
    if (index >= 0) {
      return index + 1
    }
  }
  return 0
}

/** Where `moveColumn` puts a column: an end of the board, or next to another column. */
export type ColumnPosition = 'first' | 'last' | { before: string } | { after: string }

/**
 * Give a column a new name. The column's slug follows its name, so a name
 * whose slug another column already has is refused — two columns answering to
 * one slug would make `card move` ambiguous. So is renaming To Do to anything
 * whose slug is not `to_do`: `kanbo ready` takes work from the column with that
 * slug (`ops/ready.ts`), and a renamed To Do would leave agents with nothing to
 * take. A new spelling of the same slug (`To do`, `TO-DO`) is fine.
 */
export async function renameColumn<TStore extends BoardStore>(
  store: TStore,
  workspaceId: string,
  nameOrId: string,
  newName: string,
  actor: BoardActor,
  scope?: BoardWriteScope<TStore>,
): Promise<IssueStatus> {
  assertPersonChangesColumns(actor, { workspaceId, statusName: nameOrId })
  const name = requireColumnName(newName, workspaceId)
  return await runBoardWrite(store, async ({ tx }) => {
    const column = await requireColumn(tx, workspaceId, nameOrId)
    assertRenameAllowed(await listColumns(tx, workspaceId), column, name)
    if (column.name === name) {
      return column
    }
    return await updateColumn(tx, column.id, { name }, actor, { tx })
  }, scope)
}

/**
 * Move a column to an end of the board, or right before or after another one.
 * The other columns keep their order; a move that changes nothing writes
 * nothing.
 */
export async function moveColumn<TStore extends BoardStore>(
  store: TStore,
  workspaceId: string,
  nameOrId: string,
  position: ColumnPosition,
  actor: BoardActor,
  scope?: BoardWriteScope<TStore>,
): Promise<IssueStatus[]> {
  assertPersonChangesColumns(actor, { workspaceId, statusName: nameOrId })
  return await runBoardWrite(store, async ({ tx }) => {
    const column = await requireColumn(tx, workspaceId, nameOrId)
    const columns = await listColumns(tx, workspaceId)
    const others = columns.filter(candidate => candidate.id !== column.id)

    if (typeof position !== 'string') {
      const anchor = await requireColumn(tx, workspaceId, 'before' in position ? position.before : position.after)
      if (anchor.id === column.id) {
        return columns
      }
    }
    const index = await indexForPosition(tx, workspaceId, others, position)
    const ordered = [...others.slice(0, index), column, ...others.slice(index)]
    if (ordered.every((candidate, order) => candidate.id === columns[order]?.id && candidate.order === order)) {
      return columns
    }
    await reorderColumns(tx, workspaceId, ordered.map(candidate => candidate.id), { tx })
    return await listColumns(tx, workspaceId)
  }, scope)
}

/** What `addColumn` makes: a column's name and what it says, and where it goes. */
export interface AddColumnInput {
  name: string
  description?: string | null
  color?: string | null
  category?: IssueStatus['category']
  /**
   * Where it goes. Left out: before the board's first completed column (Done),
   * else before the first canceled one, else at the end — so work still to do
   * stays on the left.
   */
  position?: ColumnPosition
}

/**
 * Add a column at its place on the board in one write: the column, and the
 * order of every column after it. The name is checked inside the write, so
 * two people adding the same name at once do not both get it.
 */
export async function addColumn<TStore extends BoardStore>(
  store: TStore,
  workspaceId: string,
  input: AddColumnInput,
  actor: BoardActor,
  scope?: BoardWriteScope<TStore>,
): Promise<IssueStatus> {
  assertPersonChangesColumns(actor, { workspaceId, name: input.name })
  const name = requireColumnName(input.name, workspaceId)
  return await runBoardWrite(store, async ({ tx }) => {
    const columns = await listColumns(tx, workspaceId)
    assertNameFree(columns, null, name, workspaceId)
    const index = await indexForPosition(tx, workspaceId, columns, input.position ?? defaultAddPosition(columns))
    const created = await insertColumn(tx, {
      workspaceId,
      name,
      description: input.description,
      color: input.color,
      category: input.category,
    }, index)
    for (const [offset, column] of columns.slice(index).entries()) {
      if (column.order !== index + 1 + offset) {
        await tx.statuses.update(column.id, { order: index + 1 + offset })
      }
    }
    for (const [order, column] of columns.slice(0, index).entries()) {
      if (column.order !== order) {
        await tx.statuses.update(column.id, { order })
      }
    }
    return created
  }, scope)
}

/** Where a new column goes when nobody said: before Done, else before Canceled, else last. */
function defaultAddPosition(columns: IssueStatus[]): ColumnPosition {
  const end = columns.find(column => column.category === 'completed') ?? columns.find(column => column.category === 'canceled')
  return end ? { before: end.id } : 'last'
}

/** The index in `others` (the board without the column being placed) a position names. */
async function indexForPosition(
  store: BoardStore,
  workspaceId: string,
  others: IssueStatus[],
  position: ColumnPosition,
): Promise<number> {
  if (position === 'first') {
    return 0
  }
  if (position === 'last') {
    return others.length
  }
  const anchor = await requireColumn(store, workspaceId, 'before' in position ? position.before : position.after)
  const anchorIndex = others.findIndex(candidate => candidate.id === anchor.id)
  return 'before' in position ? anchorIndex : anchorIndex + 1
}

/** What `removeColumn` does with the cards still in the column. */
export interface RemoveColumnOptions {
  /** The column they move to, by id or any spelling of its name. Required when the column holds cards. */
  moveCardsTo?: string | null
}

/** What `removeColumn` did. */
export interface RemoveColumnResult {
  removed: IssueStatus
  movedCards: number
  movedTo: IssueStatus | null
  /** Moved cards that entered the target without meeting its entry rules — a person's move warns, it does not refuse. */
  unmetRules?: Array<{ issueId: string, unmet: UnmetEntryRule[] }>
}

/**
 * Take a column off the board. A column that still holds cards is only
 * removed together with moving them — in the same write, each card's history
 * recording the move, exactly as `moveCard` would (a card waiting for a person
 * keeps waiting) — so no card is left in no column. To Do is never removed:
 * agents take their work from it (`ops/ready.ts`). The columns left are
 * numbered 0..n-1.
 *
 * The column's row is locked before its cards are read, so on Postgres a card
 * put into it meanwhile waits for this write — and is checked for once more
 * before the delete.
 */
export async function removeColumn<TStore extends BoardStore>(
  store: TStore,
  workspaceId: string,
  nameOrId: string,
  options: RemoveColumnOptions,
  actor: BoardActor,
  scope?: BoardWriteScope<TStore>,
): Promise<RemoveColumnResult> {
  assertPersonChangesColumns(actor, { workspaceId, statusName: nameOrId })
  return await runBoardWrite(store, async ({ tx }) => {
    const found = await requireColumn(tx, workspaceId, nameOrId)
    const column = await tx.statuses.lockById(found.id)
    if (!column) {
      throw new BoardError('issue_status_not_found', { workspaceId, statusName: nameOrId })
    }
    if (normalizeStatusName(column.name) === READY_COLUMN_SLUG) {
      throw new BoardError('board_column_ready_protected', { workspaceId, statusName: column.name })
    }
    const cards = await cardsInColumn(tx, column)
    const target = options.moveCardsTo ? await requireColumn(tx, workspaceId, options.moveCardsTo) : null
    if (target?.id === column.id) {
      throw new BoardError('board_column_remove_target_invalid', { workspaceId, statusName: column.name })
    }
    if (cards.length > 0 && !target) {
      throw new BoardError('board_column_not_empty', { workspaceId, statusName: column.name, cardCount: cards.length })
    }
    let unmetRules: RemoveColumnResult['unmetRules']
    if (cards.length > 0 && target) {
      unmetRules = (await bulkUpdateCards(tx, cards.map(card => card.id), { statusId: target.id }, actor, { tx })).unmetRules
    }
    // `deleteColumn` counts the column's cards once more: one that arrived
    // after the list above refuses the whole write rather than losing its column.
    await deleteColumn(tx, column.id, { tx })
    const result: RemoveColumnResult = { removed: column, movedCards: cards.length, movedTo: cards.length > 0 ? target : null }
    return unmetRules && unmetRules.length > 0 ? { ...result, unmetRules } : result
  }, scope)
}

/** The cards sitting in the column right now. */
async function cardsInColumn(store: BoardStore, column: IssueStatus): Promise<Issue[]> {
  return (await store.issues.listByWorkspace(column.workspaceId)).filter(card => card.statusId === column.id)
}

/** Number the workspace's columns 0..n-1 in board order, writing only the ones that change. */
async function renumberColumns(store: BoardStore, workspaceId: string): Promise<void> {
  for (const [order, column] of (await listColumns(store, workspaceId)).entries()) {
    if (column.order !== order) {
      await store.statuses.update(column.id, { order })
    }
  }
}

/** One past the last column's order: a board whose orders have gaps still gets a new, unshared one. */
function nextOrder(columns: IssueStatus[]): number {
  return columns.reduce((max, column) => Math.max(max, column.order), -1) + 1
}

/** The name, trimmed, or the error that says a column needs one. */
function requireColumnName(name: string, workspaceId: string): string {
  const trimmed = name.trim()
  if (!normalizeStatusName(trimmed)) {
    throw new BoardError('issue_status_name_empty', { workspaceId })
  }
  return trimmed
}

/** Refuse a name whose slug a column other than `self` already answers to. */
function assertNameFree(columns: IssueStatus[], self: IssueStatus | null, name: string, workspaceId: string): void {
  const slug = normalizeStatusName(name)
  const taken = columns.find(other => other.id !== self?.id && normalizeStatusName(other.name) === slug)
  if (taken) {
    throw new BoardError('board_column_name_taken', { workspaceId, name, takenBy: taken.name })
  }
}

/** A new name for `column`: To Do keeps its slug, and no other column may already answer to it. */
function assertRenameAllowed(columns: IssueStatus[], column: IssueStatus, name: string): void {
  if (normalizeStatusName(column.name) === READY_COLUMN_SLUG && normalizeStatusName(name) !== READY_COLUMN_SLUG) {
    throw new BoardError('board_column_ready_protected', { workspaceId: column.workspaceId, statusName: column.name, newName: name })
  }
  assertNameFree(columns, column, name, column.workspaceId)
}

async function insertColumn(
  store: BoardStore,
  input: BoardColumnInput,
  order: number,
): Promise<IssueStatus> {
  return await store.statuses.create({
    id: randomUUID(),
    workspaceId: input.workspaceId,
    name: input.name,
    description: input.description ?? null,
    color: input.color ?? null,
    category: input.category ?? 'unstarted',
    entryRules: serializeEntryRules(input.entryRules ?? null),
    order,
    createdAt: currentUnixSeconds(),
  })
}

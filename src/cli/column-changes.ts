import type { ColumnTemplateId } from '../domain/column-templates'
import { COLUMN_TEMPLATE_IDS, COLUMN_TEMPLATE_LABELS, COLUMN_TEMPLATES, findCatalogueColumn, ownColumn } from '../domain/column-templates'
import { BoardError } from '../domain/errors'
import { normalizeStatusName } from '../domain/status-name'
import type { ColumnPosition } from '../ops/columns'
import type { BoardActor } from '../ops/types'
import type { IssueStatus } from '../sqlite/schema'
import type { BoardSession } from './command'
import type { CliResult } from './output'
import { CliError } from './output'
import { describeColumns, projectColumn } from './view'

/**
 * What `kanbo columns add|rename|move|remove|template` do to a board, once
 * the command or the `kanbo columns` menu knows what the person asked for.
 * Both run these, so a change made from the menu reads exactly like the
 * command it names.
 *
 * A refusal of the board's is said as a sentence with the command to type
 * instead, rather than as its code: these are a person's commands.
 */

export const COLUMN_CATEGORIES = ['backlog', 'unstarted', 'started', 'completed', 'canceled'] as const satisfies readonly IssueStatus['category'][]

export interface AddColumnRequest {
  name: string
  /** Put it right after this column; `before` the other way round. Neither: before the first Done-like column. */
  after?: string
  before?: string
  description?: string
  category?: IssueStatus['category']
}

/** The whole board's columns after a change, and the sentence that says what changed. */
async function changed(session: BoardSession, message: string, extra: Record<string, unknown> = {}): Promise<CliResult> {
  const views = (await session.ops.listColumns(session.workspace.id)).map(projectColumn)
  return { value: { ...extra, columns: views }, text: `${message}\n\n${describeColumns(views)}` }
}

/**
 * A new column, placed in the same write that creates it. A ready-made name
 * (`QA`, `Blocked`) brings its own line and category; any other name is work
 * in progress. With no place given it goes before the board's first completed
 * column (Done), or Canceled, so work still to do stays on the left.
 */
export async function addColumn(session: BoardSession, request: AddColumnRequest, actor: BoardActor): Promise<CliResult> {
  const workspaceId = session.workspace.id
  const name = request.name.trim()
  if (!normalizeStatusName(name)) {
    throw new CliError(1, 'Give the column a name.')
  }
  if (request.after !== undefined && request.before !== undefined) {
    throw new CliError(1, 'Pass --after or --before, not both.')
  }
  const existing = await session.ops.findColumn(workspaceId, name)
  if (existing) {
    throw new CliError(1, `This board already has a column called ${existing.name} (slug ${normalizeStatusName(existing.name)}).`)
  }
  const anchorName = request.after ?? request.before
  const anchor = anchorName === undefined ? null : await requireNamedColumn(session, anchorName)

  const spec = findCatalogueColumn(name) ?? ownColumn(name, null)
  const created = await explainRefusal(session.ops.addColumn(workspaceId, {
    name,
    description: request.description?.trim() || spec.description,
    color: spec.color,
    category: request.category ?? spec.category,
    position: anchor ? (request.after !== undefined ? { after: anchor.id } : { before: anchor.id }) : undefined,
  }, actor))
  return await changed(session, `Added ${created.name} (slug ${normalizeStatusName(created.name)}).`, { added: projectColumn(created) })
}

/** Said after a rename: agents' instructions name no column but To Do, and `kanbo prime` gives them the rest. */
export const RENAME_NOTE = 'Agents read column names from kanbo prime; rename is picked up there.'

export async function renameColumn(session: BoardSession, column: string, newName: string, actor: BoardActor): Promise<CliResult> {
  const before = await requireNamedColumn(session, column)
  const renamed = await explainRefusal(session.ops.renameColumn(session.workspace.id, before.id, newName, actor))
  const message = before.name === renamed.name
    ? `${renamed.name} already has that name.`
    : `Renamed ${before.name} to ${renamed.name} (slug ${normalizeStatusName(renamed.name)}).\n${RENAME_NOTE}`
  return await changed(session, message, { renamed: projectColumn(renamed) })
}

/** `--first`, `--last`, `--before <column>` or `--after <column>` — exactly one. */
export function readColumnPosition(options: { first?: boolean, last?: boolean, before?: string, after?: string }): ColumnPosition {
  const given = [
    options.first ? 'first' as const : null,
    options.last ? 'last' as const : null,
    options.before !== undefined ? { before: options.before } : null,
    options.after !== undefined ? { after: options.after } : null,
  ].filter(position => position !== null)
  if (given.length !== 1) {
    throw new CliError(1, 'Say where the column goes: --first, --last, --before <column> or --after <column> (one of them).')
  }
  return given[0]!
}

export async function moveColumn(session: BoardSession, column: string, position: ColumnPosition, actor: BoardActor): Promise<CliResult> {
  const moving = await requireNamedColumn(session, column)
  const anchorName = typeof position === 'string' ? null : 'before' in position ? position.before : position.after
  const anchor = anchorName === null ? null : await requireNamedColumn(session, anchorName)
  const before = await session.ops.listColumns(session.workspace.id)
  const after = await session.ops.moveColumn(session.workspace.id, moving.id, position, actor)

  const where = position === 'first'
    ? 'to the start'
    : position === 'last' ? 'to the end' : `${'before' in position ? 'before' : 'after'} ${anchor!.name}`
  const same = before.map(candidate => candidate.id).join() === after.map(candidate => candidate.id).join()
  return await changed(session, same ? `${moving.name} is already there.` : `Moved ${moving.name} ${where}.`)
}

/** How many cards sit in the column right now. */
export async function countCardsIn(session: BoardSession, column: IssueStatus): Promise<number> {
  return (await session.store.issues.listInBoardOrder(session.workspace.id)).filter(card => card.statusId === column.id).length
}

export async function removeColumn(session: BoardSession, column: string, moveCardsTo: string | null, actor: BoardActor): Promise<CliResult> {
  const removing = await requireNamedColumn(session, column)
  if (moveCardsTo !== null) {
    await requireNamedColumn(session, moveCardsTo)
  }
  const result = await explainRefusal(session.ops.removeColumn(session.workspace.id, removing.id, { moveCardsTo }, actor))
  // The same warning `kanbo card move` leaves when a person's move skips a column's entry rules.
  for (const card of result.unmetRules ?? []) {
    for (const item of card.unmet) {
      console.error(`kanbo: warning: ${card.issueId} entered "${result.movedTo?.name ?? '—'}" without ${item.rule}: ${item.detail}`)
    }
  }
  const message = result.movedTo
    ? `Removed ${result.removed.name} and moved ${describeCount(result.movedCards)} to ${result.movedTo.name}.`
    : `Removed ${result.removed.name}.`
  return await changed(session, message, { removed: projectColumn(result.removed), movedCards: result.movedCards })
}

/** The template a person named, or the error that lists the ones there are. */
export function readTemplateId(value: string): ColumnTemplateId {
  const id = COLUMN_TEMPLATE_IDS.find(candidate => candidate === value.trim().toLowerCase())
  if (!id) {
    throw new CliError(1, `Unknown template "${value}". Use ${COLUMN_TEMPLATE_IDS.join(', ')}.`)
  }
  return id
}

/**
 * A template's columns on this board. An empty board gets the template as it
 * is; a board with columns only gets the ones it lacks, and only when asked
 * with `--add-missing` — a template never takes a column away.
 */
export async function applyTemplate(session: BoardSession, id: ColumnTemplateId, addMissing: boolean, actor: BoardActor): Promise<CliResult> {
  const workspaceId = session.workspace.id
  const label = COLUMN_TEMPLATE_LABELS[id]
  const present = await session.ops.listColumns(workspaceId)
  if (present.length > 0 && !addMissing) {
    throw new CliError(1, `This board already has columns. Add the ${label} columns it lacks with: kanbo columns template ${id} --add-missing`)
  }
  const { added } = present.length === 0
    ? await session.ops.applyColumnTemplate(workspaceId, COLUMN_TEMPLATES[id], { mode: 'seed' })
    : await session.ops.applyColumnTemplate(workspaceId, COLUMN_TEMPLATES[id], { mode: 'add-missing', actor })
  return await changed(session, added.length === 0 ? `This board already has every ${label} column.` : `Added ${added.join(', ')}.`, { added })
}

/** The column a person named, or the error that says the board has none by that name. */
export async function requireNamedColumn(session: BoardSession, nameOrId: string): Promise<IssueStatus> {
  const column = normalizeStatusName(nameOrId) ? await session.ops.findColumn(session.workspace.id, nameOrId) : null
  if (!column) {
    throw new CliError(1, `This board has no column "${nameOrId}". See kanbo columns list.`)
  }
  return column
}

/** The board's refusals of a column change, as sentences a person can act on. */
async function explainRefusal<T>(work: Promise<T>): Promise<T> {
  try {
    return await work
  }
  catch (error) {
    if (!(error instanceof BoardError)) {
      throw error
    }
    const details = (error.details ?? {}) as Record<string, string | number | undefined>
    switch (error.code) {
      case 'board_column_name_taken':
        throw new CliError(1, `Another column, ${details.takenBy}, already has that name (same slug). Pick another name.`)
      case 'board_column_ready_protected':
        throw new CliError(1, details.newName === undefined
          ? `${details.statusName} can't be removed: kanbo ready takes work from To Do, and agents would find no cards to take.`
          : `${details.statusName} can't be renamed to "${details.newName}": kanbo ready takes work from To Do, and agents `
            + 'would find no cards to take. Another spelling of To Do (To-do, TO DO) is fine.')
      case 'board_column_not_empty':
        throw new CliError(1, `${details.statusName} holds ${describeCount(Number(details.cardCount))}. Say where they go: `
          + `kanbo columns remove ${normalizeStatusName(String(details.statusName))} --move-cards-to <column>`)
      case 'issue_status_name_empty':
        throw new CliError(1, 'Give the column a name.')
      case 'board_column_remove_target_invalid':
        throw new CliError(1, `Cards can't move into ${details.statusName}: it is the column being removed.`)
      default:
        throw error
    }
  }
}

function describeCount(count: number): string {
  return `${count} ${count === 1 ? 'card' : 'cards'}`
}

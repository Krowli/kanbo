import type { IssueStatus } from '../sqlite/schema'
import { DEFAULT_STATUSES, normalizeStatusName } from './status-name'

/**
 * The column sets a new board can start with, as data.
 *
 * Every template has `To Do`: `kanbo ready` hands an agent its next card from
 * that column (`ops/ready.ts`), so a board without one gives an agent nothing
 * to take. The standard set is `DEFAULT_STATUSES` itself — what a board gets
 * when nobody chose.
 */

/** One column as a template describes it; the board gives it an id and a place. */
export interface ColumnSpec {
  name: string
  /** The one line an agent reads to know when a card belongs here. */
  description: string | null
  color: string | null
  category: IssueStatus['category']
}

export const COLUMN_TEMPLATE_IDS = ['standard', 'simple', 'review-qa'] as const
export type ColumnTemplateId = typeof COLUMN_TEMPLATE_IDS[number]

/** The slug of the column agents take work from; every template has it. */
export const READY_COLUMN_SLUG = 'to_do'

const [BACKLOG, TO_DO, IN_PROGRESS, IN_REVIEW, DONE, CANCELED] = DEFAULT_STATUSES.map(status => ({ ...status }))

const QA: ColumnSpec = { name: 'QA', description: 'Being tested before it counts as done', color: '#06b6d4', category: 'started' }
const BLOCKED: ColumnSpec = { name: 'Blocked', description: 'Stuck; waiting on something outside the board', color: '#ef4444', category: 'started' }

export const COLUMN_TEMPLATES: Record<ColumnTemplateId, readonly ColumnSpec[]> = {
  'standard': [BACKLOG!, TO_DO!, IN_PROGRESS!, IN_REVIEW!, DONE!, CANCELED!],
  'simple': [TO_DO!, IN_PROGRESS!, DONE!],
  'review-qa': [
    BACKLOG!,
    TO_DO!,
    IN_PROGRESS!,
    { ...IN_REVIEW!, description: 'Pull request open; waiting for code review' },
    QA,
    DONE!,
    CANCELED!,
  ],
}

/** What each template is called when a person picks one. */
export const COLUMN_TEMPLATE_LABELS: Record<ColumnTemplateId, string> = {
  'standard': 'Standard',
  'simple': 'Simple',
  'review-qa': 'Review + QA',
}

/** The ready-made columns a person picks from when they build their own set, in board order. */
export const COLUMN_CATALOGUE: readonly ColumnSpec[] = [BACKLOG!, TO_DO!, IN_PROGRESS!, IN_REVIEW!, QA, BLOCKED, DONE!, CANCELED!]

/** What a column of a person's own is when they name it: work in progress, unless they say otherwise. */
export function ownColumn(name: string, description: string | null): ColumnSpec {
  return { name: name.trim(), description: description?.trim() || null, color: '#64748b', category: 'started' }
}

/** The catalogue column this name means, in any spelling (`qa`, `In-Review`), or `null`. */
export function findCatalogueColumn(name: string): ColumnSpec | null {
  const slug = normalizeStatusName(name)
  return COLUMN_CATALOGUE.find(column => normalizeStatusName(column.name) === slug) ?? null
}

/** Does this set have the column agents take work from? */
export function hasReadyColumn(columns: readonly ColumnSpec[]): boolean {
  return columns.some(column => normalizeStatusName(column.name) === READY_COLUMN_SLUG)
}

/**
 * A person's own columns placed into a set: before its first completed column
 * (Done), so work still to do stays on the left — or before Canceled when the
 * set has no completed column, and at the end when it has neither.
 */
export function insertOwnColumns(columns: readonly ColumnSpec[], own: readonly ColumnSpec[]): ColumnSpec[] {
  const completed = columns.findIndex(column => column.category === 'completed')
  const at = completed >= 0 ? completed : columns.findIndex(column => column.category === 'canceled')
  const index = at < 0 ? columns.length : at
  return [...columns.slice(0, index), ...own, ...columns.slice(index)]
}

import type { BoardActiveRun, BoardRunProjection } from '../board-store'
import { cardDisplayTitle } from '../domain/card-display-title'
import type { EntryRule } from '../domain/entry-rules'
import { readEntryRules } from '../domain/entry-rules'
import { readFlowRules } from '../domain/flow-rules'
import { toIssueView } from '../domain/issue-view'
import { normalizeStatusName } from '../domain/status-name'
import type { CardLastComment } from '../ops/approval'
import type { BoardSprint } from '../ops/sprints'
import type { Issue, IssueRun, IssueStatus } from '../sqlite/schema'
import { displayWidth, padToWidth, sanitizeTerminalText } from './terminal-text'

/**
 * The board's rows as a command line prints them.
 *
 * A card row carries columns a terminal has no use for — the delegation
 * markers, the context refs, the chat session it came from — and hides the one
 * thing every caller wants, because the column is a foreign key rather than a
 * name. These projections are what `--json` selects fields from, so they are
 * also the shape a script is entitled to rely on.
 */

/** A card, as the command line prints it. */
export interface CardView {
  /** The issue key, which is also the row id: `MAN-012`. */
  id: string
  number: number
  title: string
  description: string | null
  /** The column's name, `null` when the card sits in no column. */
  column: string | null
  /** The slug of the column, as a card is moved there. */
  columnSlug: string | null
  statusLine: string | null
  waitingFor: 'human' | null
  priority: Issue['priority']
  labels: string[]
  executionMode: Issue['executionMode']
  parentIssueId: string | null
  /** Every run the card has ever had; the next launch is attempt `attemptCount + 1`. */
  attemptCount: number
  /** The run going on right now, `null` when nobody is working on the card. */
  activeRun: CardActiveRunView | null
  updatedAt: number
  /** In a list: a person sent it back and nobody has picked it up again. */
  returned?: true
  /** In a list, for a card waiting for a person or returned: its latest comment, cut short. */
  lastComment?: CardLastComment
}

/** Every field `--json` may ask of a card, in listing order. */
export const CARD_VIEW_FIELDS: readonly (keyof CardView)[] = [
  'id',
  'number',
  'title',
  'description',
  'column',
  'columnSlug',
  'statusLine',
  'waitingFor',
  'priority',
  'labels',
  'executionMode',
  'parentIssueId',
  'attemptCount',
  'activeRun',
  'updatedAt',
  'returned',
  'lastComment',
]

/** The run going on right now, as much as a line in a card list needs. */
interface CardActiveRunView {
  id: string
  agentName: string
  state: IssueRun['state']
  startedAt: number
}

/** A column of the board, as the command line prints it. */
export interface ColumnView {
  id: string
  name: string
  /** What the prime text calls this column. */
  slug: string
  description: string | null
  category: IssueStatus['category']
  order: number
  /** What a card must satisfy before an agent may move it here; empty for nothing. */
  entryRules: EntryRule[]
  /** The slugs of the columns a card may enter this one from; `null` for any, `[]` for none. */
  allowedFrom: string[] | null
  /** The most cards the column holds; `null` for no limit. */
  wipLimit: number | null
}

/** A milestone read as a sprint, as the command line prints it. Dates are unix seconds. */
export interface SprintView {
  id: string
  title: string
  status: BoardSprint['status']
  startDate: number | null
  dueDate: number | null
  /** The open sprint running today — at most one per board. */
  current: boolean
  /** Cards not yet in a completed or canceled column: what closing the sprint would carry on. */
  openCards: number
  doneCards: number
}

/** Every field `kanbo sprint list --json` may ask for, in listing order. */
export const SPRINT_VIEW_FIELDS: readonly (keyof SprintView)[] = [
  'id',
  'title',
  'status',
  'startDate',
  'dueDate',
  'current',
  'openCards',
  'doneCards',
]

export function projectCard(card: Issue, columns: IssueStatus[], runs: BoardRunProjection): CardView {
  const view = toIssueView(card)
  const column = columns.find(candidate => candidate.id === card.statusId) ?? null

  return {
    id: view.id,
    number: view.number,
    title: view.title,
    description: view.description,
    column: column?.name ?? null,
    columnSlug: column ? normalizeStatusName(column.name) : null,
    statusLine: view.statusLine,
    waitingFor: view.waitingFor,
    priority: view.priority,
    labels: view.labels,
    executionMode: view.executionMode,
    parentIssueId: view.parentIssueId,
    attemptCount: runs.attemptCount,
    activeRun: projectCardActiveRun(runs.activeRun),
    updatedAt: view.updatedAt,
  }
}

/** The run going on right now, trimmed to what a card line needs — not the agent id, the branch or the session behind it. */
function projectCardActiveRun(run: BoardActiveRun | null): CardActiveRunView | null {
  return run === null
    ? null
    : { id: run.id, agentName: run.agentName, state: run.state, startedAt: run.startedAt }
}

/** A column as the command line prints it; `board` is every column, to name the ones it accepts cards from. */
export function projectColumn(column: IssueStatus, board: readonly IssueStatus[]): ColumnView {
  const { allowedFrom, wipLimit } = readFlowRules(column)
  return {
    id: column.id,
    name: column.name,
    slug: normalizeStatusName(column.name),
    description: column.description,
    category: column.category,
    order: column.order,
    entryRules: readEntryRules(column),
    allowedFrom: allowedFrom === null ? null : board.filter(other => allowedFrom.includes(other.id)).map(other => normalizeStatusName(other.name)),
    wipLimit,
  }
}

export function projectSprint(sprint: BoardSprint): SprintView {
  return {
    id: sprint.id,
    title: sprint.title,
    status: sprint.status,
    startDate: sprint.startDate,
    dueDate: sprint.dueDate,
    current: sprint.current,
    openCards: sprint.cards.open,
    doneCards: sprint.cards.done,
  }
}

/** The whole card, for a person who asked about exactly one. */
export function describeCard(card: CardView): string {
  // Everything here was written by someone: no escape sequence of theirs reaches the terminal.
  const lines = [
    `${card.id}  ${sanitizeTerminalText(card.column ?? '—')}  ${card.executionMode}`,
    sanitizeTerminalText(cardDisplayTitle(card)),
  ]
  if (card.description) {
    lines.push('', sanitizeTerminalText(card.description, { multiline: true }))
  }
  const facts = [
    card.statusLine ? `status line: ${sanitizeTerminalText(card.statusLine)}` : null,
    card.waitingFor === 'human' ? 'waiting for a person' : null,
    card.labels.length > 0 ? `labels: ${sanitizeTerminalText(card.labels.join(', '))}` : null,
    card.priority === 'none' ? null : `priority: ${card.priority}`,
    card.parentIssueId ? `parent: ${card.parentIssueId}` : null,
  ].filter(fact => fact !== null)
  if (facts.length > 0) {
    lines.push('', ...facts)
  }
  return lines.join('\n')
}

/** One column per line, in board order, with the slug a card is moved by. */
export function describeColumns(columns: ColumnView[]): string {
  if (columns.length === 0) {
    return 'This board has no columns yet'
  }

  const slugWidth = Math.max(...columns.map(column => displayWidth(sanitizeTerminalText(column.slug))))
  return columns
    .map(column => [
      `${padToWidth(sanitizeTerminalText(column.slug), slugWidth)}  ${sanitizeTerminalText(column.name)}`,
      column.description ? ` — ${sanitizeTerminalText(column.description)}` : '',
      column.entryRules.length > 0 ? ` [requires: ${column.entryRules.join(', ')}]` : '',
      column.allowedFrom === null ? '' : ` [from: ${column.allowedFrom.length > 0 ? column.allowedFrom.join(', ') : 'no column'}]`,
      column.wipLimit === null ? '' : ` [wip: ${column.wipLimit}]`,
    ].join(''))
    .join('\n')
}

/** A unix-seconds date as the UTC day it falls on, `—` for none. */
function formatDay(seconds: number | null): string {
  return seconds === null ? '—' : new Date(seconds * 1000).toISOString().slice(0, 10)
}

/** One sprint per line: `*` on the current one, its dates, open and done cards, title and id. */
export function describeSprints(sprints: SprintView[]): string {
  if (sprints.length === 0) {
    return 'This board has no milestones yet'
  }

  return sprints
    .map(sprint => [
      sprint.current ? '*' : ' ',
      `${formatDay(sprint.startDate)} → ${formatDay(sprint.dueDate)}`,
      sprint.status.padEnd(6),
      `${sprint.openCards} open / ${sprint.doneCards} done`,
      `${sprint.title}  (${sprint.id})`,
    ].join('  '))
    .join('\n')
}

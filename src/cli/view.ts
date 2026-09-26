import type { BoardActiveRun, BoardRunProjection } from '../board-store'
import { cardDisplayTitle } from '../domain/card-display-title'
import type { EntryRule } from '../domain/entry-rules'
import { readEntryRules } from '../domain/entry-rules'
import { toIssueView } from '../domain/issue-view'
import { normalizeStatusName } from '../domain/status-name'
import type { BoardRunView } from '../ops/runs'
import type { BoardSprint } from '../ops/sprints'
import type { Issue, IssueRun, IssueStatus } from '../sqlite/schema'

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
  /** The same column as the slug `kanbo card move` takes. */
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
}

/** Every field `kanbo card list|get --json` may ask for, in listing order. */
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
  /** What `kanbo card move` and the prime text call this column. */
  slug: string
  description: string | null
  category: IssueStatus['category']
  order: number
  /** What a card must satisfy before an agent may move it here; empty for nothing. */
  entryRules: EntryRule[]
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

/** One launch of a card, as the command line prints it. */
export interface RunView {
  id: string
  issueId: string
  agentName: string
  state: IssueRun['state']
  executionMode: IssueRun['executionMode']
  branch: string | null
  worktreePath: string | null
  startedAt: number
  endedAt: number | null
  /** Which launch of the card this is, counting from its first — `listRuns` counts them. */
  attempt: number
  chatSessionId: string | null
  /** Where the agent's own log of this run lives, once it said (ruling 7-1): `claude:<id>` or `codex:<id>`, else `null`. */
  externalSessionRef: string | null
  launchedByKind: IssueRun['launchedByKind']
}

/** Every field `kanbo run start|finish|attach-session --json` may ask for, in listing order. */
export const RUN_VIEW_FIELDS: readonly (keyof RunView)[] = [
  'id',
  'issueId',
  'agentName',
  'state',
  'executionMode',
  'branch',
  'worktreePath',
  'startedAt',
  'endedAt',
  'attempt',
  'chatSessionId',
  'externalSessionRef',
  'launchedByKind',
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

export function projectColumn(column: IssueStatus): ColumnView {
  return {
    id: column.id,
    name: column.name,
    slug: normalizeStatusName(column.name),
    description: column.description,
    category: column.category,
    order: column.order,
    entryRules: readEntryRules(column),
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

export function projectRun(run: BoardRunView): RunView {
  return {
    id: run.id,
    issueId: run.issueId,
    agentName: run.agentName,
    state: run.state,
    executionMode: run.executionMode,
    branch: run.branch,
    worktreePath: run.worktreePath,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    attempt: run.attempt,
    chatSessionId: run.chatSessionId,
    externalSessionRef: run.externalSessionRef,
    launchedByKind: run.launchedByKind,
  }
}

/** One card per line: the key, the column it is in, and what it is called (`cardDisplayTitle`). */
export function describeCards(cards: CardView[]): string {
  if (cards.length === 0) {
    return 'No cards'
  }

  const keyWidth = Math.max(...cards.map(card => card.id.length))
  const columnWidth = Math.max(...cards.map(card => (card.column ?? '—').length))
  return cards
    .map(card => `${card.id.padEnd(keyWidth)}  ${(card.column ?? '—').padEnd(columnWidth)}  ${cardDisplayTitle(card)}`)
    .join('\n')
}

/** The whole card, for a person who asked about exactly one. */
export function describeCard(card: CardView): string {
  const lines = [
    `${card.id}  ${card.column ?? '—'}  ${card.executionMode}`,
    cardDisplayTitle(card),
  ]
  if (card.description) {
    lines.push('', card.description)
  }
  const facts = [
    card.statusLine ? `status line: ${card.statusLine}` : null,
    card.waitingFor === 'human' ? 'waiting for a person' : null,
    card.labels.length > 0 ? `labels: ${card.labels.join(', ')}` : null,
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

  const slugWidth = Math.max(...columns.map(column => column.slug.length))
  return columns
    .map(column => [
      `${column.slug.padEnd(slugWidth)}  ${column.name}`,
      column.description ? ` — ${column.description}` : '',
      column.entryRules.length > 0 ? ` [requires: ${column.entryRules.join(', ')}]` : '',
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

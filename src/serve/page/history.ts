import type { IssueActivityField, IssueActivityItemView, IssueActivityValueView } from '../../domain/activity-types'
import type { IssueFieldChange } from '../../sqlite/schema'

/**
 * A card's history as the panel tells it: one entry per change, newest first,
 * with the field in plain words and the old and new value as text. Comments
 * are not here; they have their own section.
 */

export interface HistoryEntry {
  id: string
  actor: { kind: IssueActivityItemView['actor']['kind'], name: string, label: string | null }
  /** 'created the card', 'moved it', 'changed', 'updated the description', … */
  verb: string
  /** Plain-words field name: status is 'Column', status-line is 'Status line', … */
  field: string | null
  from: string | null
  to: string | null
  /** For description changes, the raw texts from /field-changes when the row is there. */
  text: { before: string | null, after: string | null } | null
  at: number // unix seconds
}

/** Exhaustive over `IssueActivityField`: a new field fails the typecheck here until it has a name. */
function fieldName(field: IssueActivityField): string {
  switch (field) {
    case 'assignee': return 'Assignee'
    case 'description': return 'Description'
    case 'due-date': return 'Due date'
    case 'labels': return 'Labels'
    case 'metadata': return 'Metadata'
    case 'milestone': return 'Milestone'
    case 'parent': return 'Parent card'
    case 'priority': return 'Priority'
    case 'status': return 'Column'
    case 'status-line': return 'Status line'
    case 'title': return 'Title'
    case 'workspace': return 'Workspace'
  }
}

export function toHistory(activity: IssueActivityItemView[], fieldChanges: IssueFieldChange[]): HistoryEntry[] {
  const rows = new Map(fieldChanges.map(row => [row.id, row]))
  const entries: HistoryEntry[] = []
  for (const item of activity) {
    if (item.kind === 'comment') {
      continue
    }
    const actor = { kind: item.actor.kind, name: item.actor.displayName, label: item.actor.label }
    const base = { id: item.id, actor, field: null, from: null, to: null, text: null, at: item.createdAt }
    const change = item.fieldChange
    if (item.kind === 'created') {
      entries.push({ ...base, verb: 'created the card' })
    }
    else if (!change) {
      entries.push({ ...base, verb: 'changed the card' })
    }
    else if (change.action === 'added-description' || change.action === 'updated-description' || change.action === 'cleared-description') {
      const row = rows.get(item.id)
      const verb = change.action === 'added-description'
        ? 'added the description'
        : change.action === 'cleared-description' ? 'cleared the description' : 'updated the description'
      entries.push({ ...base, verb, text: row ? { before: row.fromValue, after: row.toValue } : null })
    }
    else if (change.field === 'metadata' || change.field === null) {
      // The raw values of a field the page has no name for are not shown.
      entries.push({ ...base, verb: 'changed metadata' })
    }
    else {
      const verb = change.field === 'status' ? 'moved it' : change.action === 'renamed-issue' ? 'renamed it' : 'changed'
      entries.push({ ...base, verb, field: fieldName(change.field), from: describeValue(change.fromValue), to: describeValue(change.toValue) })
    }
  }
  return [...entries].sort((left, right) => right.at - left.at)
}

export function describeValue(value: IssueActivityValueView | null): string {
  if (!value) {
    return 'nothing'
  }
  if (value.kind === 'text') {
    return value.text
  }
  if (value.kind === 'date') {
    return new Date(value.timestamp * 1000).toLocaleDateString()
  }
  return value.token === 'current-user' ? 'you' : value.token.replaceAll('-', ' ')
}

function sameDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate()
}

function shortDate(date: Date, now: Date): string {
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  })
}

function dayLabel(date: Date, now: Date): string {
  if (sameDay(date, now)) {
    return 'Today'
  }
  if (sameDay(date, new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) {
    return 'Yesterday'
  }
  return shortDate(date, now)
}

/** Consecutive entries of the same local day, in the order given. */
export function groupByDay(entries: HistoryEntry[], now: Date): { day: string, entries: HistoryEntry[] }[] {
  const groups: { day: string, entries: HistoryEntry[] }[] = []
  for (const entry of entries) {
    const day = dayLabel(new Date(entry.at * 1000), now)
    const last = groups.at(-1)
    if (last && last.day === day) {
      last.entries.push(entry)
    }
    else {
      groups.push({ day, entries: [entry] })
    }
  }
  return groups
}

/**
 * When something happened, for a line under its day's heading: today as
 * `just now`, `N min ago` or `N h ago`; any other day as the clock time
 * (`14:02`), since the heading already says which day.
 */
export function relativeTime(seconds: number, now: Date): string {
  const date = new Date(seconds * 1000)
  if (!sameDay(date, now)) {
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  }
  const elapsed = Math.floor(now.getTime() / 1000) - seconds
  if (elapsed < 60) {
    return 'just now'
  }
  if (elapsed < 3600) {
    return `${Math.floor(elapsed / 60)} min ago`
  }
  return `${Math.floor(elapsed / 3600)} h ago`
}

/** When something happened, said with no day heading above it: today's relative time, else the day. */
export function relativeDay(seconds: number, now: Date): string {
  const date = new Date(seconds * 1000)
  return sameDay(date, now) ? relativeTime(seconds, now) : dayLabel(date, now)
}

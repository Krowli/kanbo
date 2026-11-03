import { describe, expect, it } from 'vitest'

import type { IssueFieldChange } from '../../sqlite/schema'
import { activityFixture } from './fixtures'
import type { HistoryEntry } from './history'
import { groupByDay, relativeDay, relativeTime, toHistory } from './history'

const text = (value: string) => ({ kind: 'text' as const, text: value })

describe('toHistory', () => {
  it('drops comments and reads the created item with its actor', () => {
    const entries = toHistory([
      activityFixture({ id: 'c:created', kind: 'created', actor: { kind: 'user', id: '__self__', displayName: 'You', avatarUrl: null, label: null } }),
      activityFixture({ id: 'comment', kind: 'comment', comment: { content: 'hi', systemKind: null } }),
    ], [])
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ verb: 'created the card', actor: { name: 'You', kind: 'user' } })
  })

  it('puts the newest first even when the API sends oldest first', () => {
    const entries = toHistory([
      activityFixture({ id: 'a', kind: 'created', createdAt: 10 }),
      activityFixture({ id: 'b', createdAt: 30, fieldChange: { action: 'changed-field', field: 'priority', fromValue: text('low'), toValue: text('high') } }),
      activityFixture({ id: 'c', createdAt: 20, fieldChange: { action: 'changed-field', field: 'priority', fromValue: text('x'), toValue: text('low') } }),
    ], [])
    expect(entries.map(entry => entry.id)).toEqual(['b', 'c', 'a'])
  })

  it('reads a status change as moved it, in Column, from one column name to another', () => {
    const [entry] = toHistory([
      activityFixture({ id: 's', fieldChange: { action: 'changed-field', field: 'status', fromValue: text('To Do'), toValue: text('In Progress') } }),
    ], [])
    expect(entry).toMatchObject({ verb: 'moved it', field: 'Column', from: 'To Do', to: 'In Progress' })
  })

  it('carries both description texts when the raw row is there, and null when it is not', () => {
    const item = activityFixture({ id: 'row-1', fieldChange: { action: 'updated-description', field: 'description', fromValue: null, toValue: null } })
    const row = { id: 'row-1', fromValue: 'old text', toValue: 'new text' } as IssueFieldChange
    expect(toHistory([item], [row])[0].text).toEqual({ before: 'old text', after: 'new text' })
    expect(toHistory([item], [])[0].text).toBeNull()
    expect(toHistory([item], [{ ...row, id: 'other' }])[0].text).toBeNull()
  })

  it('shows a metadata change without its values', () => {
    const [entry] = toHistory([
      activityFixture({ id: 'm', fieldChange: { action: 'changed-field', field: 'metadata', fromValue: text('secret'), toValue: text('secret2') } }),
    ], [])
    expect(entry).toMatchObject({ verb: 'changed metadata', from: null, to: null })
  })
})

describe('groupByDay', () => {
  it('splits Today, Yesterday and older', () => {
    const now = new Date(2026, 10, 3, 12, 0, 0)
    const entry = (id: string, date: Date): HistoryEntry => ({
      id,
      actor: { kind: 'user', name: 'You', label: null },
      verb: 'x',
      field: null,
      from: null,
      to: null,
      text: null,
      at: Math.floor(date.getTime() / 1000),
    })
    const groups = groupByDay([
      entry('a', new Date(2026, 10, 3, 9, 0)),
      entry('b', new Date(2026, 10, 3, 8, 0)),
      entry('c', new Date(2026, 10, 2, 23, 0)),
      entry('d', new Date(2026, 9, 20, 10, 0)),
    ], now)
    expect(groups.map(group => [group.day, group.entries.length])).toEqual([
      ['Today', 2],
      ['Yesterday', 1],
      [new Date(2026, 9, 20).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }), 1],
    ])
  })
})

describe('relativeTime', () => {
  const now = new Date(2026, 10, 3, 12, 0, 0)
  const ago = (seconds: number) => Math.floor(now.getTime() / 1000) - seconds
  const at = (date: Date) => Math.floor(date.getTime() / 1000)
  const clock = (date: Date) => date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

  it('moves from just now to minutes to hours at the boundaries', () => {
    expect(relativeTime(ago(59), now)).toBe('just now')
    expect(relativeTime(ago(60), now)).toBe('1 min ago')
    expect(relativeTime(ago(2 * 3600), now)).toBe('2 h ago')
  })

  it('gives the clock time for any day but today, which the day heading above names', () => {
    const lateYesterday = new Date(2026, 10, 2, 23, 30)
    const yesterday = new Date(2026, 10, 2, 14, 2)
    const older = new Date(2026, 9, 31, 17, 20)
    expect(relativeTime(at(lateYesterday), now)).toBe(clock(lateYesterday))
    expect(relativeTime(at(yesterday), now)).toBe(clock(yesterday))
    expect(relativeTime(at(older), now)).toBe(clock(older))
    expect(relativeTime(at(yesterday), now)).not.toBe(relativeTime(at(lateYesterday), now))
  })
})

describe('relativeDay', () => {
  const now = new Date(2026, 10, 3, 12, 0, 0)
  const at = (date: Date) => Math.floor(date.getTime() / 1000)

  it('is the relative time today and the day otherwise', () => {
    expect(relativeDay(at(new Date(2026, 10, 3, 11, 30)), now)).toBe('30 min ago')
    expect(relativeDay(at(new Date(2026, 10, 2, 14, 2)), now)).toBe('Yesterday')
    expect(relativeDay(at(new Date(2026, 9, 31, 17, 20)), now)).toBe(new Date(2026, 9, 31).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }))
  })
})

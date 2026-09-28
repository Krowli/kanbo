import { describe, expect, it } from 'vitest'

import { readUnixSeconds } from './time'

describe('readUnixSeconds', () => {
  it('reads unix seconds, as a number or as digits', () => {
    expect(readUnixSeconds(1_790_589_600)).toBe(1_790_589_600)
    expect(readUnixSeconds(' 1790589600 ')).toBe(1_790_589_600)
    expect(readUnixSeconds(0)).toBe(0)
    expect(readUnixSeconds(100_000_000_000)).toBe(100_000_000_000)
  })

  it('reads an ISO date-time with Z or an offset, and a date alone as UTC midnight', () => {
    expect(readUnixSeconds('2026-09-28T10:00:00Z')).toBe(1_790_589_600)
    expect(readUnixSeconds('2026-09-28T12:00:00+02:00')).toBe(1_790_589_600)
    expect(readUnixSeconds('2026-09-28T05:30-0430')).toBe(1_790_589_600)
    expect(readUnixSeconds('2026-09-28T10:00:00.999z')).toBe(1_790_589_600)
    expect(readUnixSeconds('2026-09-28')).toBe(1_790_553_600)
  })

  it('refuses milliseconds, saying that is what they look like', () => {
    expect(() => readUnixSeconds(1_790_589_600_000)).toThrowError('looks like milliseconds — pass seconds or an ISO date')
    expect(() => readUnixSeconds('1790589600000')).toThrowError('looks like milliseconds')
  })

  it('refuses a date-time with no zone, whose moment depends on where it is read', () => {
    expect(() => readUnixSeconds('2026-09-28T10:00:00')).toThrowError('has no time zone')
    expect(() => readUnixSeconds('2026-09-28T10:00')).toThrowError('has no time zone')
  })

  it('refuses everything else instead of guessing', () => {
    for (const value of ['last tuesday', 'Sep 28 2026', '2026-09-28 10:00:00Z', '2026-02-30', '2026-13-01T00:00Z', '2026-09-28T24:00Z', '2026-09-28T10:00+25:00', '28/09/2026', '1.5', '-5', '']) {
      expect(() => readUnixSeconds(value), value).toThrowError(TypeError)
    }
    expect(() => readUnixSeconds(1.5)).toThrowError('is not unix seconds')
    expect(() => readUnixSeconds(-1)).toThrowError('is not unix seconds')
  })
})

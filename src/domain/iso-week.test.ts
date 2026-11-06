import { describe, expect, it } from 'vitest'

import { isoWeekOf, utcDayLabel } from './iso-week'

const DAY = 86_400
/** Monday 2025-12-29 00:00 UTC: the first second of ISO week 2026-W01. */
const WEEK_ONE = 1_766_966_400

describe('ISO weeks', () => {
  it('puts the days around 1 January in the ISO year their Thursday is in', () => {
    expect(isoWeekOf(WEEK_ONE)).toEqual({ week: '2026-W01', start: WEEK_ONE })
    // Friday 2027-01-01 belongs to the 53rd week of 2026.
    expect(isoWeekOf(Date.UTC(2027, 0, 1) / 1000)).toEqual({ week: '2026-W53', start: 1_798_416_000 })
    // Sunday 2021-01-03 is still 2020-W53.
    expect(isoWeekOf(Date.UTC(2021, 0, 3) / 1000)).toEqual({ week: '2020-W53', start: 1_609_113_600 })
    // Monday 2024-12-30 already starts 2025-W01.
    expect(isoWeekOf(Date.UTC(2024, 11, 30) / 1000)).toEqual({ week: '2025-W01', start: 1_735_516_800 })
  })

  it('ends a week on the last second of Sunday and starts the next on Monday at midnight UTC', () => {
    expect(isoWeekOf(WEEK_ONE + 14 * DAY - 1)).toEqual({ week: '2026-W02', start: WEEK_ONE + 7 * DAY })
    expect(isoWeekOf(WEEK_ONE + 14 * DAY)).toEqual({ week: '2026-W03', start: WEEK_ONE + 14 * DAY })
    expect(isoWeekOf(Date.UTC(2026, 10, 5, 12) / 1000)).toEqual({ week: '2026-W45', start: 1_793_577_600 })
  })

  it('names a UTC day', () => {
    expect(utcDayLabel(WEEK_ONE + DAY - 1)).toBe('2025-12-29')
    expect(utcDayLabel(WEEK_ONE + DAY)).toBe('2025-12-30')
  })
})

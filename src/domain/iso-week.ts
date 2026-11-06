const DAY_SECONDS = 86_400

/** An ISO 8601 week: its label and the Monday 00:00 UTC it starts at. */
export interface IsoWeek {
  /** `2026-W02`: the ISO year, which around 1 January is not always the calendar year. */
  week: string
  /** Monday 00:00 UTC, in unix seconds. */
  start: number
}

/** The ISO week a moment falls in, read in UTC like every board date (ruling 5x-6). */
export function isoWeekOf(seconds: number): IsoWeek {
  const day = Math.floor(seconds / DAY_SECONDS)
  // 1970-01-01 was a Thursday: Monday is 0, Sunday 6.
  const weekday = (day + 3) % 7
  const monday = day - weekday
  // A week belongs to the year its Thursday falls in.
  const thursday = monday + 3
  const year = new Date(thursday * DAY_SECONDS * 1000).getUTCFullYear()
  const januaryFirst = Date.UTC(year, 0, 1) / 1000 / DAY_SECONDS
  const week = Math.floor((thursday - januaryFirst) / 7) + 1
  return { week: `${year}-W${String(week).padStart(2, '0')}`, start: monday * DAY_SECONDS }
}

/** The UTC day a moment falls on, as `2026-01-05`. */
export function utcDayLabel(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10)
}

/**
 * Unix seconds — the unit every board timestamp column stores.
 *
 * The package carries its own clock, so it depends on nothing of its host's.
 */
export function currentUnixSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

const DAY_SECONDS = 86_400

/**
 * A board date is a calendar day (ruling 5x-6): a start is kept as the first
 * second of its UTC day, a due date as the last, so a sprint runs through its
 * due day wherever the person reading it is.
 */
export function utcDayStart(seconds: number): number {
  return Math.floor(seconds / DAY_SECONDS) * DAY_SECONDS
}

/** The last second of the UTC day `seconds` falls on — see `utcDayStart`. */
export function utcDayEnd(seconds: number): number {
  return utcDayStart(seconds) + DAY_SECONDS - 1
}

/**
 * A moment someone typed, as unix seconds: unix seconds themselves (a number,
 * or a string of digits), or a date `Date` reads — `2026-09-28`,
 * `2026-09-28T10:00:00Z`. `null` when it is neither.
 */
export function readUnixSeconds(value: number | string): number | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 0 ? value : null
  }
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed)
  }
  const milliseconds = Date.parse(trimmed)
  return Number.isNaN(milliseconds) ? null : Math.floor(milliseconds / 1000)
}

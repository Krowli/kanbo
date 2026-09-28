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

/** The largest unix seconds a moment is read as: past it, the number is milliseconds (year 5138 onwards). */
const MAX_UNIX_SECONDS = 100_000_000_000

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?$/i

/**
 * A moment someone typed, as unix seconds — or the `TypeError` that says why
 * it names none. Read are:
 *
 * - unix seconds: a whole number up to 1e11, or a string of digits;
 * - an ISO 8601 date and time with `Z` or an offset — `2026-09-28T10:00:00Z`,
 *   `2026-09-28T12:00:00+02:00`;
 * - an ISO date alone, `2026-09-28`, which is that day's UTC midnight.
 *
 * Refused are a number past 1e11 (milliseconds, most likely — `Date.now()`),
 * a date and time without a zone (whose moment depends on where it is read),
 * and anything else. Nothing is guessed: no `Date.parse` fallback.
 */
export function readUnixSeconds(value: number | string): number {
  const typed = typeof value === 'number' ? value : value.trim()
  if (typeof typed === 'number' || /^\d+$/.test(typed)) {
    const seconds = Number(typed)
    if (Number.isInteger(seconds) && seconds >= 0) {
      if (seconds > MAX_UNIX_SECONDS) {
        throw new TypeError(`${seconds} looks like milliseconds — pass seconds or an ISO date such as 2026-09-28T10:00:00Z.`)
      }
      return seconds
    }
    throw new TypeError(`${value} is not unix seconds: pass a whole number of seconds or an ISO date such as 2026-09-28T10:00:00Z.`)
  }
  const day = DATE_ONLY.exec(typed)
  if (day) {
    const seconds = utcSeconds(Number(day[1]), Number(day[2]), Number(day[3]), 0, 0, 0)
    if (seconds !== null) {
      return seconds
    }
  }
  const moment = DATE_TIME.exec(typed)
  if (moment) {
    const [, year, month, date, hours, minutes, secondsText, , zone] = moment
    if (zone === undefined) {
      throw new TypeError(`"${typed}" has no time zone — add Z or an offset, e.g. ${typed}Z or ${typed}+02:00.`)
    }
    const local = utcSeconds(Number(year), Number(month), Number(date), Number(hours), Number(minutes), Number(secondsText ?? 0))
    const offset = zoneOffsetSeconds(zone)
    if (local !== null && offset !== null) {
      return local - offset
    }
  }
  throw new TypeError(`"${typed}" is neither unix seconds nor an ISO date. Pass e.g. 2026-09-28T10:00:00Z or 2026-09-28.`)
}

/** Unix seconds of a calendar date and time read as UTC, or `null` when no such date or time exists. */
function utcSeconds(year: number, month: number, date: number, hours: number, minutes: number, seconds: number): number | null {
  if (year < 1970 || month < 1 || month > 12 || date < 1 || hours > 23 || minutes > 59 || seconds > 59) {
    return null
  }
  const milliseconds = Date.UTC(year, month - 1, date, hours, minutes, seconds)
  // `Date.UTC` rolls 30 February over into March; a day that does not exist is refused instead.
  return new Date(milliseconds).getUTCDate() === date ? Math.floor(milliseconds / 1000) : null
}

/** How far ahead of UTC a `Z`, `+02:00` or `-0530` zone is, in seconds; `null` past ±23:59. */
function zoneOffsetSeconds(zone: string): number | null {
  if (zone.toUpperCase() === 'Z') {
    return 0
  }
  const digits = zone.slice(1).replace(':', '')
  const hours = Number(digits.slice(0, 2))
  const minutes = Number(digits.slice(2))
  if (hours > 23 || minutes > 59) {
    return null
  }
  return (zone.startsWith('-') ? -1 : 1) * (hours * 3600 + minutes * 60)
}

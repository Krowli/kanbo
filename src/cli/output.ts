/**
 * Everything the board's command line writes, and the code it leaves with.
 *
 * The contract is deliberately small: a command hands back a value and — when
 * there is a good way to say it in one breath — the text a person should read.
 * `--format` chooses between the two machine shapes, and `--json <fields>` is
 * the agent's shortcut: the same value with only the named fields kept, so a
 * script can ask for `title,column` and get exactly that.
 *
 * The exit codes live here too, because a failure is output as much as a
 * result is: the board tool promises `2` for "I could not find what to work
 * on", `3` for "this database is older than I am" and `4` for "a person has to
 * do this", and a caller may branch on them.
 */

/** What a command produces: the value, and how to say it to a person. */
export interface CliResult {
  /** The machine-readable result, printed as JSON unless `text` takes over. */
  value: unknown
  /** What a person reads when no format was asked for. */
  text?: string
  /**
   * The fields `--json` may name, declared up front rather than read off a row:
   * a result that comes back as an empty list still tells a caller what it
   * could have asked for instead of guessing from nothing.
   */
  fields?: readonly string[]
}

/** The two machine shapes `--format` offers. */
export type CliFormat = 'json' | 'pretty'

/** The output flags every board command carries. */
export interface CliOutputOptions {
  /** Comma-separated field names; printing keeps only these. */
  json?: string
  format?: string
}

/** Nothing to work on, or nothing told us what to work on. */
export const EXIT_NOT_RESOLVED = 2
/** The database is older than the board schema this build speaks. */
export const EXIT_SCHEMA_OUTDATED = 3
/** The command is a person's to run, and this shell is not a person. */
export const EXIT_HUMAN_ONLY = 4

/**
 * Every exit code this tool promises, and what it means — the capabilities
 * manifest's `exitCodes` reads this rather than naming the codes again. `0` and
 * `1` are not declared above: they need no name of their own, success and "I
 * could not do that" being every command line's baseline.
 */
export const CLI_EXIT_CODES = [
  { code: 0, meaning: 'Success.' },
  { code: 1, meaning: 'The command did not do what it was asked. See the message.' },
  { code: EXIT_NOT_RESOLVED, meaning: 'Nothing to work on, or nothing told the command what to work on.' },
  { code: EXIT_SCHEMA_OUTDATED, meaning: 'The database is older than the board schema this build speaks.' },
  { code: EXIT_HUMAN_ONLY, meaning: 'The command is a person\'s to run, and this shell is not a person.' },
] as const satisfies readonly { code: number, meaning: string }[]

/**
 * A failure with a promised exit code. Anything else that goes wrong leaves
 * with `1`, which is the command line saying only that it did not work.
 */
export class CliError extends Error {
  readonly exitCode: number

  constructor(exitCode: number, message: string) {
    super(message)
    this.name = 'CliError'
    this.exitCode = exitCode
  }
}

/** The format a caller asked for, or the error that says there is no such format. */
export function readFormat(options: CliOutputOptions): CliFormat | null {
  if (options.format === undefined) {
    return null
  }
  if (options.format !== 'json' && options.format !== 'pretty') {
    throw new CliError(1, `Unknown format "${options.format}". Use json or pretty.`)
  }
  return options.format
}

/**
 * Write the result out.
 *
 * Without a format and without `--json`, a command that offered text gets its
 * text: `kanbo prime` prints the board's rules the way an agent should read
 * them, not a JSON string with the newlines spelled out. Everything else falls
 * back to indented JSON, which is the honest answer when the value has no
 * one-breath form.
 */
export function printResult(result: CliResult, options: CliOutputOptions): void {
  const fields = readFields(options.json)
  const format = readFormat(options)

  if (fields) {
    warnUnknownFields(fields, result)
    console.log(JSON.stringify(selectFields(result.value, fields), null, 2))
    return
  }
  if (format === 'json') {
    console.log(JSON.stringify(result.value))
    return
  }
  if (format === 'pretty' || result.text === undefined) {
    console.log(JSON.stringify(result.value, null, 2))
    return
  }
  console.log(result.text)
}

function readFields(json: string | undefined): string[] | null {
  if (json === undefined) {
    return null
  }
  const fields = json.split(',').map(field => field.trim()).filter(field => field.length > 0)
  if (fields.length === 0) {
    throw new CliError(1, 'Pass --json a comma-separated list of fields, for example --json title,column.')
  }
  return fields
}

/**
 * Say so, on stderr, about every field a caller asked for that this result
 * does not carry — one line per field, so a typo is caught instead of quietly
 * printing an object with the field missing. Never the exit code: the fields
 * that do exist still print, and an agent that asked for nine good fields and
 * one bad one should get the nine.
 */
function warnUnknownFields(fields: string[], result: CliResult): void {
  const available = declaredFields(result)
  for (const field of fields) {
    if (!available.includes(field)) {
      console.error(`kanbo: unknown field "${field}"; available: ${available.join(', ')}`)
    }
  }
}

/**
 * What a caller could have asked `--json` for. A result that names its fields
 * up front is trusted, because a list of them can be empty and still have
 * something to say; otherwise the first row of a list, or the record itself,
 * says what it carries.
 */
function declaredFields(result: CliResult): string[] {
  if (result.fields) {
    return [...result.fields]
  }
  const sample = Array.isArray(result.value) ? result.value[0] : result.value
  return isRecord(sample) ? Object.keys(sample) : []
}

/**
 * The same value with only the named fields kept. A list keeps them on every
 * item; a single record keeps them on itself. A field the value does not carry
 * is simply absent, rather than printed as null — a caller asking for a field
 * that is not there should see that it is not there.
 */
function selectFields(value: unknown, fields: string[]): unknown {
  if (Array.isArray(value)) {
    return value.map(item => selectFields(item, fields))
  }
  if (!isRecord(value)) {
    return value
  }
  return Object.fromEntries(fields
    .filter(field => Object.hasOwn(value, field))
    .map(field => [field, value[field]]))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

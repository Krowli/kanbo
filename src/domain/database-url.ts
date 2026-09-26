/**
 * A board's connection string, as it may be said out loud.
 *
 * Everything a person needs to recognise which board they are talking to is
 * the host and the database name. The password is the one part that must never
 * reach a terminal, a log, a `--json` result or a tool's answer — and it is not
 * the only part: a connection string carries options in its query, and a
 * `?password=…` there is as much a secret as the one in front of the host.
 *
 * It is a fact about the value rather than about the command line, which is why
 * it lives here: the MCP tools hand back messages they did not write either,
 * and they must not be made to carry the board tool's own runtime to say them
 * safely.
 */

/** What a connection string is called when there is nothing safe to print of it. */
const MASKED_UNREADABLE_URL = 'postgres://***'

/** What is printed in place of a password, and of a query that may hide one. */
const MASK = '***'

/**
 * A connection string inside a longer line. Anything but whitespace and the
 * quotes a message may wrap it in belongs to the URL — a password is allowed
 * every character a URL is, so the match has to be greedy to be safe.
 */
const DATABASE_URL_PATTERN = /\bpostgres(?:ql)?:\/\/[^\s'"`]+/gi

/**
 * The connection string with everything secret taken out of it.
 *
 * A string this cannot take apart is not examined to find out why — it is
 * replaced entirely, because whatever is wrong with it, the secret is still
 * somewhere inside. A missing scheme counts as that: `user:secret@host/db`
 * parses, as a `user:` URL whose whole password is in the path, and printing it
 * back would say the secret out loud.
 */
export function maskDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (!parsed.host) {
      return MASKED_UNREADABLE_URL
    }
    if (parsed.password) {
      parsed.password = MASK
    }
    // Not read for what it holds: an option this build has never heard of may
    // still be a credential, and the query is not what tells a person which
    // board this is.
    if (parsed.search) {
      parsed.search = MASK
    }
    return parsed.toString()
  }
  catch {
    return MASKED_UNREADABLE_URL
  }
}

/**
 * Every connection string inside a line of text, masked.
 *
 * A message this package did not write — a driver's, a migrator's — may carry
 * the whole connection string in the middle of a sentence, and it reaches the
 * same terminal, or the same agent, as everything else.
 */
export function maskDatabaseUrls(text: string): string {
  return text.replace(DATABASE_URL_PATTERN, url => maskDatabaseUrl(url))
}

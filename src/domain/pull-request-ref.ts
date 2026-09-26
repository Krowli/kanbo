import { BoardError } from './errors'

/** A GitHub pull request, as a card names it. */
export interface PullRequestRef {
  owner: string
  repo: string
  number: number
  /** The canonical `https://github.com/<owner>/<repo>/pull/<number>`, whatever form it was given in. */
  url: string
}

/**
 * The largest pull-request number a board can hold — `number` is a 32-bit
 * `integer` in the Postgres dialect.
 */
const MAX_PULL_REQUEST_NUMBER = 2_147_483_647

/**
 * A GitHub owner (user or organisation) and a repository name, as GitHub allows
 * them; both patterns are read case-insensitively. An owner may carry `_`: an
 * Enterprise Managed User is `name_shortcode`.
 */
const OWNER = '[a-z0-9](?:[\\w-]*[a-z0-9])?'
const REPO = '[\\w.-]+'

/** `https://github.com/<owner>/<repo>/pull/<n>`, with anything GitHub hangs off it — `/files`, a query, an anchor. */
const PULL_REQUEST_URL = new RegExp(`^https://(?:www\\.)?github\\.com/(${OWNER})/(${REPO})/pull/(\\d+)(?:[/?#].*)?$`, 'i')

/** `<owner>/<repo>#<n>`, the short form GitHub itself writes. */
const PULL_REQUEST_SHORT_REF = new RegExp(`^(${OWNER})/(${REPO})#(\\d+)$`, 'i')

/**
 * Read a pull request out of what a person or an agent typed: a GitHub pull
 * request URL or `owner/repo#number`. Anything else — an issue URL, a commit, a
 * host that is not GitHub, a bare number with no repository — is refused with
 * `board_pull_request_invalid` rather than guessed at, because a link the
 * watcher cannot resolve is a card that never hears about its pull request.
 *
 * GitHub owner and repository names are case-insensitive, so both are
 * lower-cased before they become a stored link or a dedupe key (ruling 4-6) —
 * `Acme/Repo#7` and `acme/repo#7` are the same pull request and must never
 * become two links or two "opened" lines.
 */
export function parsePullRequestRef(input: string): PullRequestRef {
  const value = input.trim()
  const match = PULL_REQUEST_URL.exec(value) ?? PULL_REQUEST_SHORT_REF.exec(value)
  const number = match ? Number(match[3]) : Number.NaN
  if (!match || !Number.isSafeInteger(number) || number < 1 || number > MAX_PULL_REQUEST_NUMBER || match[2] === '.' || match[2] === '..') {
    throw new BoardError('board_pull_request_invalid', { value: input })
  }
  const owner = match[1].toLowerCase()
  const repo = match[2].toLowerCase()
  return { owner, repo, number, url: `https://github.com/${owner}/${repo}/pull/${number}` }
}

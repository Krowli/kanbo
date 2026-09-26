/**
 * The dedupe keys the facts about one pull request are written under on a card.
 *
 * Whatever watches a pull request writes them — opened, merged, closed and a CI
 * verdict per head — and whatever reads a card's pull requests, this package's
 * `ci_green` entry rule included, reads them back (rulings 4-7, 6-2), so the spelling lives here,
 * with the board, rather than being copied into each. Owner and repo are lower-cased
 * because GitHub names are case-insensitive (ruling 4-6): `Acme/Repo#7` and
 * `acme/repo#7` key to the same facts.
 */
export interface PullRequestFactKeys {
  opened: string
  merged: string
  closed: string
  /** GitHub answered 404/422 for this link on enough consecutive ticks that the watcher dropped it (`pr-watcher.ts`). */
  gone: string
  /** What every CI verdict key of this pull request starts with; the head sha and `:green` or `:red` follow. */
  ciPrefix: string
}

export function pullRequestFactKeys({ owner, repo, number }: { owner: string, repo: string, number: number }): PullRequestFactKeys {
  const key = `${owner.toLowerCase()}/${repo.toLowerCase()}#${number}`
  return {
    opened: `pr-opened:${key}`,
    merged: `pr-merged:${key}`,
    closed: `pr-closed:${key}`,
    gone: `pr-gone:${key}`,
    ciPrefix: `ci:${key}@`,
  }
}

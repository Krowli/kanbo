/**
 * The card key a new board is offered, read off the project folder's name:
 * `todo-list` → `TLI`, `react-native-shop` → `RNS`, `kanbo` → `KAN`.
 *
 * The name is split into words at `-`, `_`, spaces, dots and camelCase humps.
 * Words that say nothing about the project — `app`, `the`, `project` — are
 * dropped, unless nothing else is left. Three words or more give their first
 * letters; two give the first letter of one and the first two of the other; one
 * gives its first three letters. Digits at the start of a word are skipped, so
 * the key never starts with one. The result is upper-case, padded with `X` to
 * three characters, and is `APP` when the name has nothing to offer.
 *
 * It is always three letters or digits, so `readIssuePrefix` numbers cards with
 * exactly this key.
 */

/** What a card key must look like when a person types one: a letter, then two letters or digits. */
export const CARD_KEY_PATTERN = /^[A-Z][A-Z0-9]{2}$/i

const FILLER_WORDS = new Set(['app', 'the', 'project'])

const FALLBACK_KEY = 'APP'

export function suggestCardKey(folderName: string): string {
  const words = splitWords(folderName)
  const meaningful = words.filter(word => !FILLER_WORDS.has(word.toLowerCase()))
  const picked = meaningful.length > 0 ? meaningful : words
  const key = abbreviate(picked).toUpperCase()
  return key ? key.slice(0, 3).padEnd(3, 'X') : FALLBACK_KEY
}

/** Is this a card key a person may choose? Case does not matter; it is stored upper-case. */
export function isValidCardKey(key: string): boolean {
  return CARD_KEY_PATTERN.test(key.trim())
}

function splitWords(name: string): string[] {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    // `myApp` → `my App`, `APIServer` → `API Server`.
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    // A key never starts with a digit, and neither does a word it is taken from.
    .map(word => word.replace(/^\d+/, ''))
    .filter(word => word.length > 0)
}

function abbreviate(words: string[]): string {
  if (words.length >= 3) {
    return words.slice(0, 3).map(word => word[0]).join('')
  }
  if (words.length === 2) {
    return `${words[0]![0]}${words[1]!.slice(0, 2)}`
  }
  return words[0]?.slice(0, 3) ?? ''
}

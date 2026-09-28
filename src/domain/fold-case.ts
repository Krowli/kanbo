/**
 * Text as a search compares it: every letter lowercased by Unicode's rules, not
 * only A–Z — `Über` and `über` are one word. What Postgres `ilike` does on
 * either side of a board search; SQLite's own `like` folds ASCII alone, so a
 * board file compares through this function instead (`kanbo_fold`).
 */
export function foldCase(text: string): string {
  return text.toLowerCase()
}

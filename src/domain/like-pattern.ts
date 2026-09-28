/**
 * A `like` pattern that finds `text` anywhere in a value, the text matched as
 * written: `%`, `_` and the escape character itself are escaped with `\`, the
 * character a statement names in `escape '\'`.
 */
export function containsLikePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, character => `\\${character}`)}%`
}

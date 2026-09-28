/**
 * Text from the board, made safe and measured for a terminal.
 *
 * A card's title, status line or description is whatever an agent or a person
 * wrote. Printed raw, an escape sequence in it could recolour, move the cursor
 * or retitle the terminal of whoever runs `kanbo board`; and a line cut by
 * `.length` is cut wrong as soon as it holds CJK or emoji, which take two
 * columns, or combining marks, which take none.
 */

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

// ESC [ … final byte (CSI), ESC ] … BEL or ESC \ (OSC), and any other ESC + one character.
// eslint-disable-next-line no-control-regex
const ESCAPE_SEQUENCE = /\u001B\[[0-?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)?|\u001B[\s\S]?|\u009B[0-?]*[ -/]*[@-~]/g
// C0 controls, DEL and C1 controls. Newlines and tabs are handled by the caller's choice below.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g

/**
 * The text without escape sequences or control characters. `multiline` keeps
 * line breaks (a description); otherwise every line break and tab becomes a
 * space (a title, a heading, a status line).
 */
export function sanitizeTerminalText(text: string, options: { multiline?: boolean } = {}): string {
  const stripped = text.replace(/\r\n?/g, '\n').replace(ESCAPE_SEQUENCE, '').replace(CONTROL, '')
  return options.multiline ? stripped.replace(/\t/g, '  ') : stripped.replace(/[\n\t]/g, ' ')
}

/**
 * Text every character of which is one column and one grapheme — most titles
 * and status lines. Measured by its length rather than grapheme by grapheme,
 * which on a board of thousands of cards was most of the time `kanbo board`
 * took.
 */
const PRINTABLE_ASCII = /^[\x20-\x7E]*$/

/** How many terminal columns the text takes: wide characters and emoji two, combining marks none. */
export function displayWidth(text: string): number {
  if (PRINTABLE_ASCII.test(text)) {
    return text.length
  }
  let width = 0
  for (const { segment } of segmenter.segment(text)) {
    width += graphemeWidth(segment)
  }
  return width
}

/**
 * The text cut to `room` columns, ending in `…` when it was cut, never
 * splitting a character a person sees as one (an emoji with its modifiers, a
 * letter with its accents).
 */
export function truncateToWidth(text: string, room: number): string {
  if (displayWidth(text) <= room) {
    return text
  }
  if (PRINTABLE_ASCII.test(text)) {
    return `${text.slice(0, Math.max(0, room - 1)).trimEnd()}…`
  }
  let kept = ''
  let width = 0
  for (const { segment } of segmenter.segment(text)) {
    const next = graphemeWidth(segment)
    if (width + next > room - 1) {
      break
    }
    kept += segment
    width += next
  }
  return `${kept.trimEnd()}…`
}

/** The text padded with spaces to `width` columns. */
export function padToWidth(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)))
}

function graphemeWidth(grapheme: string): number {
  if (/\p{Emoji_Presentation}/u.test(grapheme) || (/\p{Extended_Pictographic}/u.test(grapheme) && grapheme.includes('️'))) {
    return 2
  }
  const codePoint = grapheme.codePointAt(0)!
  if (isZeroWidth(codePoint)) {
    return 0
  }
  return isWide(codePoint) ? 2 : 1
}

function isZeroWidth(codePoint: number): boolean {
  return /\p{Mn}|\p{Me}|\p{Cf}/u.test(String.fromCodePoint(codePoint))
}

/** East Asian Wide and Fullwidth, in the ranges that carry them. */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115F], // Hangul Jamo initials
  [0x2E80, 0x303E], // CJK radicals, punctuation, ideographic space
  [0x3041, 0x33FF], // Hiragana, Katakana, Bopomofo, CJK compatibility
  [0x3400, 0x4DBF], // CJK extension A
  [0x4E00, 0x9FFF], // CJK unified ideographs
  [0xA000, 0xA4CF], // Yi
  [0xA960, 0xA97F], // Hangul Jamo extended A
  [0xAC00, 0xD7A3], // Hangul syllables
  [0xF900, 0xFAFF], // CJK compatibility ideographs
  [0xFE10, 0xFE19], // vertical forms
  [0xFE30, 0xFE6F], // CJK compatibility forms, small forms
  [0xFF00, 0xFF60], // fullwidth forms
  [0xFFE0, 0xFFE6], // fullwidth signs
  [0x1F300, 0x1F64F], // pictographs, emoticons
  [0x1F900, 0x1F9FF], // supplemental symbols and pictographs
  [0x20000, 0x2FFFD], // CJK extensions B–F
  [0x30000, 0x3FFFD], // CJK extension G and later
]

function isWide(codePoint: number): boolean {
  return WIDE_RANGES.some(([from, to]) => codePoint >= from && codePoint <= to)
}

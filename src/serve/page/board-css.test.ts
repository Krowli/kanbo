import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * The board page's stylesheet takes every raw value from its tokens: the
 * `:root` blocks at its top (`DIRECTION.md` beside it says what they are).
 * Anywhere else a colour, a `px` type size, a numeric `z-index` or a literal
 * timing is a value that will drift; a `var(--x)` nothing declares renders as
 * nothing; a breakpoint outside the two is a third one. A line that must break
 * a rule says why with a trailing `/* tokens-ok: <reason> *\/`.
 */

/** The breakpoints `DIRECTION.md` names, and the two preferences the page follows. */
const ALLOWED_MEDIA_FEATURES = new Set([
  'min-width: 40rem',
  'min-width: 56.25rem',
  'prefers-color-scheme: dark',
  'prefers-color-scheme: light',
  'prefers-reduced-motion: reduce',
  'prefers-reduced-motion: no-preference',
])

/** CSS named colours, `transparent` and `currentColor` left out: those two are allowed anywhere. */
const NAMED_COLOURS = new Set(('aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue '
  + 'blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue '
  + 'darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid '
  + 'darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink '
  + 'deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold '
  + 'goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush '
  + 'lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey '
  + 'lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime '
  + 'limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen '
  + 'mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin '
  + 'navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise '
  + 'palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue '
  + 'saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow '
  + 'springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen').split(' '))

interface Declaration {
  property: string
  value: string
  /** The selectors and at-rules it sits in, outermost first. */
  context: string[]
  lines: number[]
}

/** Comments become spaces (newlines kept, so line numbers still match). */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, comment => comment.replace(/[^\n]/g, ' '))
}

/** Every declaration and every block prelude, with the lines each spans. */
function parse(css: string): { declarations: Declaration[], preludes: { text: string, line: number }[] } {
  const declarations: Declaration[] = []
  const preludes: { text: string, line: number }[] = []
  const context: string[] = []
  let buffer = ''
  let start = 1
  let line = 1
  const take = (): { text: string, lines: number[] } => {
    const text = buffer.trim()
    const first = start + (buffer.slice(0, buffer.length - buffer.trimStart().length).match(/\n/g)?.length ?? 0)
    buffer = ''
    start = line
    return { text, lines: Array.from({ length: line - first + 1 }, (_, index) => first + index) }
  }
  const declare = (text: string, lines: number[]): void => {
    const colon = text.indexOf(':')
    if (colon > 0) {
      declarations.push({ property: text.slice(0, colon).trim().toLowerCase(), value: text.slice(colon + 1).trim(), context: [...context], lines })
    }
  }
  for (const char of css) {
    if (char === '{') {
      const { text, lines } = take()
      preludes.push({ text, line: lines[0] })
      context.push(text)
    }
    else if (char === ';') {
      const { text, lines } = take()
      declare(text, lines)
    }
    else if (char === '}') {
      const { text, lines } = take()
      declare(text, lines)
      context.pop()
    }
    else {
      buffer += char
      if (char === '\n') {
        line += 1
      }
    }
  }
  return { declarations, preludes }
}

function colourLiteral(value: string): string | null {
  const unquoted = value.replace(/'[^']*'|"[^"]*"/g, '')
  const functional = unquoted.match(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/i)
  if (functional) {
    return functional[0]
  }
  return unquoted.match(/[a-z-]+/gi)?.find(word => NAMED_COLOURS.has(word.toLowerCase())) ?? null
}

/** What in `css` does not come from its tokens, one line each, with its line number. */
function findTokenProblems(css: string): string[] {
  const optedOut = new Set(css.split('\n').flatMap((text, index) => /\/\*\s*tokens-ok:\s*\S[^*]*\*\//.test(text) ? [index + 1] : []))
  const { declarations, preludes } = parse(stripComments(css))
  const declared = new Set(declarations.filter(item => item.property.startsWith('--')).map(item => item.property))
  const problems: string[] = []

  for (const item of declarations) {
    if (item.lines.some(line => optedOut.has(line))) {
      continue
    }
    const where = `line ${item.lines[0]}: ${item.property}: ${item.value.replace(/\s+/g, ' ')}`
    const inTokens = item.context.includes(':root')
    const colour = colourLiteral(item.value)
    if (colour && !inTokens) {
      problems.push(`${where} — colour literal ${colour} (use a --color-* token)`)
    }
    if ((item.property === 'font-size' || item.property === 'font') && /\d(?:\.\d+)?px\b/.test(item.value)) {
      problems.push(`${where} — font-size in px (use a --text-* token)`)
    }
    if (item.property === 'z-index' && /^-?\d+$/.test(item.value)) {
      problems.push(`${where} — numeric z-index (use a --z-* token)`)
    }
    if (/^(?:transition|animation)(?:-|$)/.test(item.property) && !inTokens
      && /(?<![\w-])\d*\.?\d+m?s\b|cubic-bezier\(|steps\(/.test(item.value)) {
      problems.push(`${where} — literal timing (use a --duration-* or --ease-* token)`)
    }
    for (const match of item.value.matchAll(/var\(\s*(--[\w-]+)/g)) {
      if (!declared.has(match[1])) {
        problems.push(`${where} — ${match[1]} is never declared`)
      }
    }
  }

  for (const prelude of preludes) {
    if (!prelude.text.startsWith('@media') || optedOut.has(prelude.line)) {
      continue
    }
    const features = [...prelude.text.matchAll(/\(([^)]*)\)/g)].map(match => match[1].replace(/\s+/g, ' ').replace(/\s*:\s*/, ': ').trim())
    if (features.length === 0 || features.some(feature => !ALLOWED_MEDIA_FEATURES.has(feature))) {
      problems.push(`line ${prelude.line}: ${prelude.text} — not one of the breakpoints in DIRECTION.md or a colour/motion preference`)
    }
  }
  return problems
}

describe('board.css', () => {
  it('takes every raw value from its tokens', () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'board.css'), 'utf8')
    expect(findTokenProblems(css)).toEqual([])
  })
})

describe('findTokenProblems', () => {
  const tokens = ':root {\n  --color-text: #1B2129;\n  --z-panel: 10;\n  --duration-fast: 120ms;\n}\n'

  it('allows raw values in :root, light, dark or reduced-motion', () => {
    expect(findTokenProblems(`${tokens}@media (prefers-color-scheme: dark) {\n  :root {\n    --color-text: rgb(0 0 0 / 50%);\n  }\n}\n`)).toEqual([])
  })

  it('finds a planted colour literal in a component, and passes once it is gone', () => {
    const planted = `${tokens}.card {\n  color: #fff;\n}\n`
    expect(findTokenProblems(planted)).toEqual(['line 7: color: #fff — colour literal #fff (use a --color-* token)'])
    expect(findTokenProblems(planted.replace('#fff', 'var(--color-text)'))).toEqual([])
  })

  it('finds rgb(), oklch() and named colours, but not transparent or currentColor', () => {
    const problems = findTokenProblems(`${tokens}.a {\n  background: rgb(0 0 0);\n  color: oklch(50% 0 0);\n  border: 1px solid white;\n  outline-color: currentColor;\n  fill: transparent;\n}\n`)
    expect(problems).toHaveLength(3)
    expect(problems.join('\n')).toMatch(/rgb\(.*\n.*oklch\(.*\n.*white/)
  })

  it('finds px font sizes, numeric z-index, literal timings, undeclared variables', () => {
    const problems = findTokenProblems(`${tokens}.a {\n  font-size: 14px;\n  z-index: 5;\n  transition:\n    opacity 150ms ease;\n  animation: spin 1s linear;\n  color: var(--color-nope);\n}\n`)
    expect(problems.map(problem => problem.split(' — ')[1])).toEqual([
      'font-size in px (use a --text-* token)',
      'numeric z-index (use a --z-* token)',
      'literal timing (use a --duration-* or --ease-* token)',
      'literal timing (use a --duration-* or --ease-* token)',
      '--color-nope is never declared',
    ])
  })

  it('allows token timings, rem font sizes and z-index from a token', () => {
    expect(findTokenProblems(`${tokens}.a {\n  font-size: 0.75rem;\n  z-index: var(--z-panel);\n  transition: opacity var(--duration-fast) ease;\n  animation: ping var(--duration-fast) 1;\n}\n`)).toEqual([])
  })

  it('finds a breakpoint DIRECTION.md does not name', () => {
    expect(findTokenProblems(`${tokens}@media (min-width: 48rem) {\n  .a {\n    color: var(--color-text);\n  }\n}\n`))
      .toEqual(['line 6: @media (min-width: 48rem) — not one of the breakpoints in DIRECTION.md or a colour/motion preference'])
    expect(findTokenProblems(`${tokens}@media (min-width: 40rem) {\n  .a {\n    color: var(--color-text);\n  }\n}\n`)).toEqual([])
  })

  it('lets a line opt out with a reason', () => {
    expect(findTokenProblems(`${tokens}.a {\n  color: #fff; /* tokens-ok: the print logo is always white */\n}\n`)).toEqual([])
  })
})

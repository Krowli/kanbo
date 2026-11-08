import { el } from './dom'

/**
 * Markdown for the card dialog: a GitHub-flavoured subset, built for text that
 * agents write and nobody reviews. Two layers. `parseMarkdown` is a pure
 * function from text to blocks and is tested with no DOM; `renderMarkdown`
 * turns those into elements made with `el()` and text nodes, so nothing in the
 * source is ever parsed as HTML. HTML tags are shown as typed, an image is
 * never made (`![alt](url)` becomes a link), and only `http:`, `https:` and
 * `mailto:` addresses become links, decided in `safeUrl` and nowhere else.
 *
 * Supported: headings, paragraphs, fenced code, bullet, numbered and task
 * lists (nested by indentation), quotes, rules, tables, and inline code,
 * bold, italic, strikethrough, links, bare links and backslash escapes.
 * Anything else is text.
 *
 * Limits: a source over `MAX_SOURCE` characters is shown as plain text,
 * block nesting stops at `MAX_DEPTH` (deeper lines are text of the last
 * level), and the inline parser has a work budget so unmatched delimiters
 * cannot make it slow.
 */

export const MAX_SOURCE = 100_000
const MAX_DEPTH = 8

export type Align = 'left' | 'center' | 'right'

export interface ListItem {
  /** `null` for a plain item, else the state of its `[ ]` / `[x]` box. */
  checked: boolean | null
  /** The item's own lines, joined with a newline. */
  text: string
  /** What follows the text: nested lists, code, quotes. */
  blocks: Block[]
}

export type Block =
  | { type: 'heading', level: 1 | 2 | 3, text: string }
  | { type: 'paragraph', text: string }
  | { type: 'code', info: string, text: string }
  | { type: 'list', ordered: boolean, start: number, items: ListItem[] }
  | { type: 'quote', blocks: Block[] }
  | { type: 'hr' }
  | { type: 'table', align: Align[], head: string[], rows: string[][] }

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const QUOTE = /^ {0,3}>/
const ITEM = /^( *)([-*+]|\d{1,9}[.)])( +|$)(.*)$/
const TASK = /^\[([ xX])\](?:[ \t]+|$)/
const DELIMITER_CELL = /^:?-+:?$/

const isBlank = (line: string): boolean => line.trim() === ''
const indentOf = (line: string): number => line.length - line.trimStart().length
const isOrderedMarker = (marker: string): boolean => /\d/.test(marker[0]!)

/** Whether a line starts a block of its own, so a paragraph or an item's text ends before it. */
function startsBlock(line: string, interrupting: boolean): boolean {
  if (FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line)) {
    return true
  }
  const item = ITEM.exec(line)
  if (!item) {
    return false
  }
  if (!interrupting) {
    return true
  }
  // Inside a paragraph a list begins only with a bullet or with "1.", and not empty.
  return item[4]!.trim() !== '' && (!isOrderedMarker(item[2]!) || parseInt(item[2]!, 10) === 1)
}

/** The cells of a table row, the outer pipes dropped and `\|` kept as a pipe. */
function splitRow(line: string): string[] {
  let row = line.trim()
  if (row.startsWith('|')) {
    row = row.slice(1)
  }
  if (row.endsWith('|') && !row.endsWith('\\|')) {
    row = row.slice(0, -1)
  }
  const cells: string[] = []
  let current = ''
  for (let i = 0; i < row.length; i++) {
    if (row[i] === '\\' && row[i + 1] === '|') {
      current += '|'
      i++
    } else if (row[i] === '|') {
      cells.push(current.trim())
      current = ''
    } else {
      current += row[i]
    }
  }
  cells.push(current.trim())
  return cells
}

function tableAt(lines: readonly string[], index: number): Extract<Block, { type: 'table' }> & { next: number } | null {
  const header = lines[index]!
  const delimiter = lines[index + 1]
  if (delimiter === undefined || !header.includes('|') || !delimiter.includes('|')) {
    return null
  }
  const marks = splitRow(delimiter)
  const head = splitRow(header)
  if (marks.length !== head.length || !marks.every(mark => DELIMITER_CELL.test(mark))) {
    return null
  }
  const align = marks.map((mark): Align => mark.startsWith(':') && mark.endsWith(':') ? 'center' : mark.endsWith(':') ? 'right' : 'left')
  const rows: string[][] = []
  let next = index + 2
  while (next < lines.length && !isBlank(lines[next]!) && lines[next]!.includes('|')) {
    const cells = splitRow(lines[next]!).slice(0, head.length)
    while (cells.length < head.length) {
      cells.push('')
    }
    rows.push(cells)
    next++
  }
  return { type: 'table', align, head, rows, next }
}

function listAt(lines: readonly string[], start: number, depth: number): { block: Block, next: number } {
  const first = ITEM.exec(lines[start]!)!
  const base = first[1]!.length
  const ordered = isOrderedMarker(first[2]!)
  const items: ListItem[] = []
  let i = start
  let end = start
  while (i < lines.length) {
    const marker = ITEM.exec(lines[i]!)
    if (!marker || marker[1]!.length >= base + 2 || isOrderedMarker(marker[2]!) !== ordered || HR.test(lines[i]!)) {
      break
    }
    const spaces = marker[3]!.length
    const column = marker[1]!.length + marker[2]!.length + (spaces >= 1 && spaces <= 4 && marker[4] !== '' ? spaces : 1)
    const threshold = marker[1]!.length + 2
    const body = [marker[4]!]
    i++
    while (i < lines.length) {
      const line = lines[i]!
      if (isBlank(line)) {
        let k = i
        while (k < lines.length && isBlank(lines[k]!)) {
          k++
        }
        if (k < lines.length && indentOf(lines[k]!) >= threshold) {
          while (i < k) {
            body.push('')
            i++
          }
          continue
        }
        break
      }
      const indent = indentOf(line)
      if (indent >= threshold) {
        body.push(line.slice(Math.min(indent, column)))
      } else if (!isBlank(body[body.length - 1]!) && !startsBlock(line, false)) {
        body.push(line.trim())
      } else {
        break
      }
      i++
    }
    items.push(listItem(body, depth))
    end = i
    let k = i
    while (k < lines.length && isBlank(lines[k]!)) {
      k++
    }
    i = k
  }
  return { block: { type: 'list', ordered, start: ordered ? parseInt(first[2]!, 10) : 1, items }, next: end }
}

function listItem(body: readonly string[], depth: number): ListItem {
  const textLines = [body[0]!]
  let j = 1
  while (j < body.length && !isBlank(body[j]!) && !startsBlock(body[j]!, false)) {
    textLines.push(body[j]!.trim())
    j++
  }
  let text = textLines.join('\n')
  let checked: boolean | null = null
  const task = TASK.exec(text)
  if (task) {
    checked = task[1] !== ' '
    text = text.slice(task[0].length)
  }
  return { checked, text, blocks: parseBlocks(body.slice(j), depth + 1) }
}

function parseBlocks(lines: readonly string[], depth: number): Block[] {
  if (depth >= MAX_DEPTH) {
    const text = lines.map(line => line.trim()).join('\n').trim()
    return text === '' ? [] : [{ type: 'paragraph', text }]
  }
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (isBlank(line)) {
      i++
      continue
    }
    const fence = FENCE.exec(line)
    if (fence) {
      const mark = fence[1]!
      const body: string[] = []
      i++
      while (i < lines.length) {
        const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[i]!)
        if (closing && closing[1]![0] === mark[0] && closing[1]!.length >= mark.length) {
          i++
          break
        }
        body.push(lines[i]!)
        i++
      }
      blocks.push({ type: 'code', info: fence[2]!.trim(), text: body.join('\n') })
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      blocks.push({ type: 'heading', level: Math.min(heading[1]!.length, 3) as 1 | 2 | 3, text: (heading[2] ?? '').trim() })
      i++
      continue
    }
    if (HR.test(line)) {
      blocks.push({ type: 'hr' })
      i++
      continue
    }
    if (QUOTE.test(line)) {
      const inner: string[] = []
      while (i < lines.length && QUOTE.test(lines[i]!)) {
        inner.push(lines[i]!.replace(/^ {0,3}> ?/, ''))
        i++
      }
      blocks.push({ type: 'quote', blocks: parseBlocks(inner, depth + 1) })
      continue
    }
    if (ITEM.test(line)) {
      const list = listAt(lines, i, depth)
      blocks.push(list.block)
      i = list.next
      continue
    }
    const table = tableAt(lines, i)
    if (table) {
      const { next, ...block } = table
      blocks.push(block)
      i = next
      continue
    }
    const paragraph = [line.trim()]
    i++
    while (i < lines.length && !isBlank(lines[i]!) && !startsBlock(lines[i]!, true)) {
      paragraph.push(lines[i]!.trim())
      i++
    }
    blocks.push({ type: 'paragraph', text: paragraph.join('\n') })
  }
  return blocks
}

/** The blocks of a Markdown source. Pure: no DOM. */
export function parseMarkdown(source: string): Block[] {
  return parseBlocks(source.split(/\r?\n/), 0)
}

// Inline

type Inline =
  | { type: 'text', text: string }
  | { type: 'code', text: string }
  | { type: 'br' }
  | { type: 'strong' | 'em' | 'del', children: Inline[] }
  | { type: 'link', href: string, children: Inline[] }

/** The one place that decides which addresses become links: http, https and mailto. */
export function safeUrl(raw: string): string | null {
  const url = raw.trim()
  return /^(https?:|mailto:)/i.test(url) && !/\s/.test(url) ? url : null
}

interface InlineContext {
  /** Characters the delimiter searches may still scan; when spent, delimiters are plain text. */
  budget: number
}

const WORD = /[\p{L}\p{N}]/u
const PUNCTUATION = /[!-/:-@[-`{-~]/
const BARE_URL = /https?:\/\/[^\s<]+/iy

function trimUrl(url: string): string {
  let end = url.length
  while (end > 0 && '.,;:!?)'.includes(url[end - 1]!)) {
    if (url[end - 1] === ')') {
      const kept = url.slice(0, end)
      if (kept.split('(').length >= kept.split(')').length) {
        break
      }
    }
    end--
  }
  return url.slice(0, end)
}

/** Where a closing `marker` starts after `from`, or -1. `_` closes only at a word edge; a closer follows non-space. */
function findCloser(text: string, marker: string, from: number, context: InlineContext): number {
  const char = marker[0]!
  let j = from
  while (j < text.length) {
    const found = text.indexOf(marker, j)
    context.budget -= (found === -1 ? text.length : found) - j + 1
    if (found === -1 || context.budget < 0) {
      return -1
    }
    let runEnd = found
    while (text[runEnd] === char) {
      runEnd++
    }
    const run = runEnd - found
    const before = text[found - 1]
    const after = text[runEnd]
    const wide = marker.length === 2 ? run >= 2 : run === 1
    const spaced = before === undefined || /\s/.test(before)
    const edge = char === '_' && after !== undefined && WORD.test(after)
    if (wide && found > from && !spaced && !edge) {
      return found
    }
    j = runEnd
  }
  return -1
}

/** A link at `[` (index `open`): its text, its address and where it ends, or null. */
function linkAt(text: string, open: number, context: InlineContext): { label: string, url: string, end: number } | null {
  const close = text.indexOf(']', open + 1)
  context.budget -= (close === -1 ? text.length : close) - open + 1
  if (close === -1 || text[close + 1] !== '(' || context.budget < 0) {
    return null
  }
  let depth = 1
  let k = close + 2
  while (k < text.length && depth > 0) {
    if (text[k] === '(') {
      depth++
    } else if (text[k] === ')') {
      depth--
    }
    k++
  }
  context.budget -= k - close
  if (depth !== 0 || context.budget < 0) {
    return null
  }
  const url = text.slice(close + 2, k - 1).trim().split(/\s+/)[0] ?? ''
  return { label: text.slice(open + 1, close), url, end: k }
}

function parseInline(text: string, context: InlineContext, depth: number, inLink: boolean): Inline[] {
  const out: Inline[] = []
  let buffer = ''
  const flush = (): void => {
    if (buffer !== '') {
      out.push({ type: 'text', text: buffer })
      buffer = ''
    }
  }
  const nest = depth < MAX_DEPTH
  let i = 0
  while (i < text.length) {
    const char = text[i]!
    if (char === '\\' && i + 1 < text.length && PUNCTUATION.test(text[i + 1]!)) {
      buffer += text[i + 1]
      i += 2
      continue
    }
    if (char === '\n') {
      flush()
      out.push({ type: 'br' })
      i++
      continue
    }
    if (char === '`') {
      let run = i
      while (text[run] === '`') {
        run++
      }
      const ticks = '`'.repeat(run - i)
      let search = run
      let end = -1
      while (search < text.length) {
        const found = text.indexOf(ticks, search)
        context.budget -= (found === -1 ? text.length : found) - search + 1
        if (found === -1 || context.budget < 0) {
          break
        }
        let stop = found
        while (text[stop] === '`') {
          stop++
        }
        if (stop - found === ticks.length) {
          end = found
          break
        }
        search = stop
      }
      if (end === -1) {
        buffer += ticks
        i = run
      } else {
        let code = text.slice(run, end).replace(/\n/g, ' ')
        if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim() !== '') {
          code = code.slice(1, -1)
        }
        flush()
        out.push({ type: 'code', text: code })
        i = end + ticks.length
      }
      continue
    }
    if ((char === '*' || char === '_' || char === '~') && nest) {
      let run = i
      while (text[run] === char) {
        run++
      }
      const size = run - i
      const length = char === '~' ? (size >= 2 ? 2 : 0) : size >= 2 ? 2 : 1
      const next = text[i + length]
      const opens = length > 0
        && next !== undefined
        && !/\s/.test(next)
        && (char !== '_' || i === 0 || !WORD.test(text[i - 1]!))
      const marker = char.repeat(length)
      const close = opens ? findCloser(text, marker, i + length, context) : -1
      if (close === -1) {
        buffer += text.slice(i, run)
        i = run
      } else {
        flush()
        const children = parseInline(text.slice(i + length, close), context, depth + 1, inLink)
        out.push({ type: char === '~' ? 'del' : length === 2 ? 'strong' : 'em', children })
        i = close + length
      }
      continue
    }
    if ((char === '[' || (char === '!' && text[i + 1] === '[')) && nest && !inLink) {
      const open = char === '!' ? i + 1 : i
      const link = linkAt(text, open, context)
      const href = link ? safeUrl(link.url) : null
      if (link && href) {
        flush()
        const label = char === '!' ? (link.label.trim() === '' ? [{ type: 'text', text: href } as Inline] : parseInline(link.label, context, depth + 1, true)) : parseInline(link.label, context, depth + 1, true)
        out.push({ type: 'link', href, children: label.length > 0 ? label : [{ type: 'text', text: href }] })
        i = link.end
      } else {
        buffer += char
        i++
      }
      continue
    }
    if (char === '<' && !inLink) {
      const auto = /^<([^\s<>]+)>/.exec(text.slice(i, i + 2000))
      const href = auto ? safeUrl(auto[1]!) : null
      if (auto && href) {
        flush()
        out.push({ type: 'link', href, children: [{ type: 'text', text: href }] })
        i += auto[0].length
        continue
      }
    }
    if ((char === 'h' || char === 'H') && !inLink && (i === 0 || !WORD.test(text[i - 1]!))) {
      BARE_URL.lastIndex = i
      const bare = BARE_URL.exec(text)
      if (bare) {
        const url = trimUrl(bare[0])
        if (/^https?:\/\/./i.test(url)) {
          flush()
          out.push({ type: 'link', href: url, children: [{ type: 'text', text: url }] })
          i += url.length
          continue
        }
      }
    }
    buffer += char
    i++
  }
  flush()
  return out
}

// Rendering

function inlineNodes(inlines: readonly Inline[]): Node[] {
  return inlines.map((inline): Node => {
    switch (inline.type) {
      case 'text':
        return document.createTextNode(inline.text)
      case 'br':
        return document.createElement('br')
      case 'code':
        return el('code', undefined, inline.text)
      case 'link': {
        const link = el('a')
        link.href = inline.href
        link.target = '_blank'
        link.rel = 'noopener noreferrer'
        link.title = inline.href
        link.append(...inlineNodes(inline.children))
        return link
      }
      default: {
        const element = el(inline.type)
        element.append(...inlineNodes(inline.children))
        return element
      }
    }
  })
}

function inlineInto(parent: HTMLElement, text: string): void {
  const context: InlineContext = { budget: 50 * text.length + 10_000 }
  parent.append(...inlineNodes(parseInline(text, context, 0, false)))
}

function cell(tag: 'th' | 'td', text: string, align: Align): HTMLElement {
  const element = el(tag)
  if (align !== 'left') {
    element.dataset.align = align
  }
  inlineInto(element, text)
  return element
}

function blockNode(block: Block): HTMLElement {
  switch (block.type) {
    case 'heading': {
      const element = el(block.level === 1 ? 'h4' : block.level === 2 ? 'h5' : 'h6', `md-h${block.level}`)
      inlineInto(element, block.text)
      return element
    }
    case 'paragraph': {
      const element = el('p')
      inlineInto(element, block.text)
      return element
    }
    case 'code': {
      const pre = el('pre')
      pre.append(el('code', undefined, block.text))
      return pre
    }
    case 'list': {
      const list = el(block.ordered ? 'ol' : 'ul')
      if (block.ordered && block.start !== 1) {
        (list as HTMLOListElement).start = block.start
      }
      for (const item of block.items) {
        const li = el('li', item.checked === null ? undefined : 'md-task')
        if (item.checked !== null) {
          const box = el('input')
          box.type = 'checkbox'
          box.disabled = true
          box.checked = item.checked
          li.append(box)
        }
        inlineInto(li, item.text)
        li.append(...item.blocks.map(blockNode))
        list.append(li)
      }
      return list
    }
    case 'quote': {
      const quote = el('blockquote')
      quote.append(...block.blocks.map(blockNode))
      return quote
    }
    case 'hr':
      return el('hr')
    case 'table': {
      const wrapper = el('div', 'md-table')
      const table = el('table')
      const head = el('thead')
      const headRow = el('tr')
      block.head.forEach((text, column) => headRow.append(cell('th', text, block.align[column]!)))
      head.append(headRow)
      const body = el('tbody')
      for (const row of block.rows) {
        const tr = el('tr')
        row.forEach((text, column) => tr.append(cell('td', text, block.align[column]!)))
        body.append(tr)
      }
      table.append(head, body)
      wrapper.append(table)
      return wrapper
    }
  }
}

/** A `div` with `className` and `markdown`, holding the source as elements; over `MAX_SOURCE` characters, a `div.markdown-plain` of the text. */
export function renderMarkdown(source: string, className: string): HTMLElement {
  if (source.length > MAX_SOURCE) {
    return el('div', `${className} markdown-plain`, source)
  }
  const root = el('div', `${className} markdown`)
  root.append(...parseMarkdown(source).map(blockNode))
  return root
}

// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { MAX_SOURCE, parseMarkdown, renderMarkdown } from './markdown'

const OWNER_EXAMPLE = [
  'Главная карточка. Брать подзадачи по номеру, а не эту карточку.',
  '',
  '## Что видит клиент сейчас',
  'Проверено 2026-11-08: hotfix/node-24.22.1 = d8d31f15.',
  '- **Вход**: после email и неверного пароля только «Nieprawidłowe dane».',
  '- **Двухфакторного входа нет**: `supabase/config.toml` → `[auth.mfa]` выключен.',
  '',
  '## Где код',
  '- `src/lib/auth/actions.ts`: серверные действия входа',
  '  - `signInWithEmail`: строка 102;',
  '  - `signInWithPassword`: строка 609;',
].join('\n')

const render = (source: string): HTMLElement => renderMarkdown(source, 'description')

describe('renderMarkdown', () => {
  it('shows the owner example formatted', () => {
    const root = render(OWNER_EXAMPLE)
    expect([...root.querySelectorAll('h5')].map(h => h.textContent)).toEqual(['Что видит клиент сейчас', 'Где код'])
    const lists = root.querySelectorAll(':scope > ul')
    expect(lists).toHaveLength(2)
    const first = lists[0]!.querySelector('li')!
    expect(first.firstElementChild?.tagName).toBe('STRONG')
    expect(first.firstElementChild?.textContent).toBe('Вход')
    expect([...root.querySelectorAll('code')].map(c => c.textContent)).toContain('supabase/config.toml')
    const top = lists[1]!.querySelector(':scope > li')!
    expect(top.firstElementChild?.tagName).toBe('CODE')
    const nested = top.querySelectorAll(':scope > ul > li')
    expect(nested).toHaveLength(2)
    expect(nested[0]!.firstElementChild?.tagName).toBe('CODE')
    expect(nested[0]!.firstElementChild?.textContent).toBe('signInWithEmail')
    expect(nested[1]!.firstElementChild?.textContent).toBe('signInWithPassword')
    expect(root.className).toBe('description markdown')
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      expect(node.textContent).not.toContain('**')
      expect(node.textContent).not.toContain('## ')
    }
  })

  it('never makes an img or script from HTML text', () => {
    const root = render('<img src=x onerror=alert(1)>\n\n<script>alert(1)</script>')
    expect(root.querySelector('img, script')).toBeNull()
    expect(root.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(root.textContent).toContain('<script>alert(1)</script>')
  })

  it('makes no link from an unsafe address', () => {
    for (const source of [
      '[x](javascript:alert(1))',
      '[x](JAVASCRIPT:alert(1))',
      '[x]( javascript:alert(1))',
      '[x](data:text/html,<b>)',
      '![x](javascript:alert(1))',
      '<javascript:alert(1)>',
      '[x](/relative)',
    ]) {
      expect(render(source).querySelector('a'), source).toBeNull()
    }
    expect(render('[x](javascript:alert(1))').textContent).toBe('[x](javascript:alert(1))')
  })

  it('makes a safe link open in a new tab without an opener', () => {
    const links = render('[docs](https://example.com/a_b)').querySelectorAll('a')
    expect(links).toHaveLength(1)
    expect(links[0]!.getAttribute('href')).toBe('https://example.com/a_b')
    expect(links[0]!.target).toBe('_blank')
    expect(links[0]!.rel).toBe('noopener noreferrer')
    expect(links[0]!.title).toBe('https://example.com/a_b')
    expect(render('[m](MAILTO:a@b.c)').querySelector('a')?.getAttribute('href')).toBe('MAILTO:a@b.c')
  })

  it('turns an image into a link and never an img', () => {
    const root = render('![shot](https://example.com/p.png) ![](https://example.com/q.png)')
    expect(root.querySelector('img')).toBeNull()
    expect([...root.querySelectorAll('a')].map(a => a.textContent)).toEqual(['shot', 'https://example.com/q.png'])
  })

  it('drops the trailing punctuation of a bare link', () => {
    expect(render('See https://example.com/x.').querySelector('a')?.getAttribute('href')).toBe('https://example.com/x')
    expect(render('(see https://example.com/x)').querySelector('a')?.getAttribute('href')).toBe('https://example.com/x')
    expect(render('https://example.com/a_(b)').querySelector('a')?.getAttribute('href')).toBe('https://example.com/a_(b)')
    expect(render('<https://example.com/z>').querySelector('a')?.getAttribute('href')).toBe('https://example.com/z')
  })

  it('trims a long run of closing parentheses from a bare link in linear time', () => {
    const links = render(`https://x${')'.repeat(40000)}`).querySelectorAll('a')
    expect(links).toHaveLength(1)
    expect(links[0]!.getAttribute('href')).toBe('https://x')
  })

  it('keeps a fence verbatim', () => {
    const root = render('```ts\n**not bold** <b>\n```')
    expect(root.querySelector('pre > code')?.textContent).toBe('**not bold** <b>')
    expect(root.querySelector('strong, b')).toBeNull()
  })

  it('does not italicise snake_case_name or 2 * 3 * 4', () => {
    expect(render('snake_case_name').querySelector('em')).toBeNull()
    expect(render('2 * 3 * 4').querySelector('em')).toBeNull()
    expect(render('2 * 3 * 4').textContent).toBe('2 * 3 * 4')
  })

  it('formats bold, italic, strikethrough, inline code and escapes', () => {
    const root = render('**a** __b__ *c* _d_ ~~e~~ `f` \\*g\\*')
    expect(root.querySelectorAll('strong')).toHaveLength(2)
    expect(root.querySelectorAll('em')).toHaveLength(2)
    expect(root.querySelector('del')?.textContent).toBe('e')
    expect(root.querySelector('code')?.textContent).toBe('f')
    expect(root.textContent).toContain('*g*')
    expect(render('`` a`b ``').querySelector('code')?.textContent).toBe('a`b')
  })

  it('renders a paragraph newline as br and headings by level', () => {
    const root = render('one\ntwo\n\n# a\n## b\n### c\n###### d')
    expect(root.querySelectorAll('p')).toHaveLength(1)
    expect(root.querySelector('p br')).not.toBeNull()
    expect(root.querySelector('h4.md-h1')?.textContent).toBe('a')
    expect(root.querySelector('h5.md-h2')?.textContent).toBe('b')
    expect(root.querySelectorAll('h6.md-h3')).toHaveLength(2)
  })

  it('renders a table with alignment', () => {
    const root = render('| a | b | c |\n|---|:--:|--:|\n| 1 | 2 | 3 |\n| 4 | 5 |\n| 6 | 7 | 8 | 9 |\n\nafter')
    expect(root.querySelectorAll('th')).toHaveLength(3)
    expect(root.querySelectorAll('td')).toHaveLength(9)
    expect(root.querySelector('.md-table > table')).not.toBeNull()
    expect([...root.querySelectorAll('th')].map(th => th.dataset.align)).toEqual([undefined, 'center', 'right'])
    expect(root.querySelector('p')?.textContent).toBe('after')
    expect(root.querySelector('[style]')).toBeNull()
  })

  it('renders task lists with disabled boxes', () => {
    const root = render('- [ ] open\n- [x] done')
    const boxes = [...root.querySelectorAll<HTMLInputElement>('input[type=checkbox]')]
    expect(boxes.map(box => box.disabled)).toEqual([true, true])
    expect(boxes.map(box => box.checked)).toEqual([false, true])
    expect(root.querySelectorAll('li.md-task')).toHaveLength(2)
  })

  it('renders a quote, a rule and an ordered list from 3', () => {
    const root = render('> quoted **b**\n\n---\n\n3. x\n4. y')
    expect(root.querySelector('blockquote strong')?.textContent).toBe('b')
    expect(root.querySelector('hr')).not.toBeNull()
    expect(root.querySelector('ol')?.start).toBe(3)
    expect(root.querySelectorAll('ol > li')).toHaveLength(2)
  })

  it('shows a source over the limit as plain text', () => {
    const root = render(`# x\n${'a'.repeat(MAX_SOURCE)}`)
    expect(root.className).toContain('markdown-plain')
    expect(root.querySelector('h4')).toBeNull()
    expect(root.textContent?.startsWith('# x')).toBe(true)
  })

  it('survives 200 nested quotes and lists', () => {
    const quotes = render(`${'>'.repeat(200)} deep`)
    expect(quotes.querySelectorAll('blockquote').length).toBeLessThanOrEqual(8)
    expect(quotes.textContent).toContain('deep')
    const lines = Array.from({ length: 200 }, (_, depth) => `${'  '.repeat(depth)}- item${depth}`).join('\n')
    const lists = render(lines)
    expect(lists.querySelectorAll('ul').length).toBeLessThanOrEqual(8)
    expect(lists.textContent).toContain('item199')
  })

  it('finishes on many unmatched delimiters and shows them as text', () => {
    for (const char of ['*', '[', '_', '`', '~', '!', '<', 'h']) {
      // A line of only * or _ is a rule, so the run follows a letter.
      const source = `a${char.repeat(20000)}`
      expect(render(source).textContent === source).toBe(true)
    }
    const mixed = '*a '.repeat(10000)
    expect(render(mixed).textContent === mixed.trim()).toBe(true)
  })
})

describe('parseMarkdown', () => {
  it('parses headings and caps the level at 3', () => {
    expect(parseMarkdown('# a\n#### b\n#nope')).toEqual([
      { type: 'heading', level: 1, text: 'a' },
      { type: 'heading', level: 3, text: 'b' },
      { type: 'paragraph', text: '#nope' },
    ])
  })

  it('nests lists by indentation', () => {
    const [list] = parseMarkdown('- a\n  - b\n    - c\n- d')
    if (list?.type !== 'list') {
      throw new Error('not a list')
    }
    expect(list.items.map(item => item.text)).toEqual(['a', 'd'])
    const nested = list.items[0]!.blocks[0]
    if (nested?.type !== 'list') {
      throw new Error('no nested list')
    }
    expect(nested.items[0]!.text).toBe('b')
    expect(nested.items[0]!.blocks[0]).toMatchObject({ type: 'list' })
  })

  it('joins continuation lines of an item and starts an ordered list at its first number', () => {
    expect(parseMarkdown('7) a\n   more')).toEqual([
      { type: 'list', ordered: true, start: 7, items: [{ checked: null, text: 'a\nmore', blocks: [] }] },
    ])
  })

  it('runs an unclosed fence to the end', () => {
    expect(parseMarkdown('~~~sh\nls\n\nrm')).toEqual([{ type: 'code', info: 'sh', text: 'ls\n\nrm' }])
  })

  it('parses a table and stops it at a blank line', () => {
    const blocks = parseMarkdown('a|b\n-|:-:\n1|2\n\ntext')
    expect(blocks[0]).toEqual({ type: 'table', align: ['left', 'center'], head: ['a', 'b'], rows: [['1', '2']] })
    expect(blocks[1]).toEqual({ type: 'paragraph', text: 'text' })
  })

  it('reads --- under a line as a rule', () => {
    expect(parseMarkdown('a\n---').map(block => block.type)).toEqual(['paragraph', 'hr'])
  })
})

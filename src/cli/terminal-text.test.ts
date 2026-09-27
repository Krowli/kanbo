import { describe, expect, it } from 'vitest'

import { displayWidth, padToWidth, sanitizeTerminalText, truncateToWidth } from './terminal-text'

describe('terminal text', () => {
  it.each([
    ['plain', 'abc', 3],
    ['CJK', '漢字テスト', 10],
    ['Hangul', '한국어', 6],
    ['fullwidth', 'ＡＢ', 4],
    ['combining accent', 'été', 3],
    ['zero-width space', 'a​b', 2],
    ['emoji', '👍', 2],
    ['emoji with skin tone', '👍🏽', 2],
    ['ZWJ family', '👨‍👩‍👧', 2],
    ['flag', '🇺🇦', 2],
    ['text symbol made emoji', '❤️', 2],
    ['text symbol', '©', 1],
  ])('measures %s', (_name, text, width) => {
    expect(displayWidth(text)).toBe(width)
  })

  it('cuts by columns and by whole graphemes, never halfway through one', () => {
    expect(truncateToWidth('漢字漢字漢字', 5)).toBe('漢字…')
    expect(displayWidth(truncateToWidth('漢字漢字漢字', 5))).toBeLessThanOrEqual(5)
    expect(truncateToWidth('ab👨‍👩‍👧👨‍👩‍👧', 5)).toBe('ab👨‍👩‍👧…')
    expect(truncateToWidth('éééé', 3)).toBe('éé…')
    expect(truncateToWidth('short', 10)).toBe('short')
  })

  it('pads by columns', () => {
    expect(padToWidth('漢', 4)).toBe('漢  ')
  })

  it('takes out escape sequences and control characters', () => {
    expect(sanitizeTerminalText('\u001B[31mred\u001B[0m title')).toBe('red title')
    expect(sanitizeTerminalText('a\u001B]0;pwned\u0007b')).toBe('ab')
    expect(sanitizeTerminalText('a\u001B]8;;http://x\u001B\\link\u001B]8;;\u001B\\b')).toBe('alinkb')
    expect(sanitizeTerminalText('a\u009B31mb\u0007c\u0000d\u007Fe')).toBe('abcde')
    expect(sanitizeTerminalText('two\nlines\tand tab\r\nend')).toBe('two lines and tab end')
    expect(sanitizeTerminalText('two\nlines\r\n\u001B[2Jend', { multiline: true })).toBe('two\nlines\nend')
  })
})

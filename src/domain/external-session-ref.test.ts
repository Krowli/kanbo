import { describe, expect, it } from 'vitest'

import { BoardError } from './errors'
import { formatExternalSessionRef, parseExternalSessionRef } from './external-session-ref'

describe('parseExternalSessionRef', () => {
  it.each([
    ['claude:01978e4e-58e2-7d3a-9b1a-1234567890ab', 'claude', '01978e4e-58e2-7d3a-9b1a-1234567890ab'],
    ['codex:019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b', 'codex', '019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b'],
    ['  claude:abc  ', 'claude', 'abc'],
    ['codex:a.b_c-9', 'codex', 'a.b_c-9'],
  ])('reads %s', (input, provider, id) => {
    expect(parseExternalSessionRef(input)).toEqual({ provider, id })
  })

  it('formats back to the stored form', () => {
    expect(formatExternalSessionRef({ provider: 'claude', id: 'abc' })).toBe('claude:abc')
  })

  it.each([
    '',
    'claude:',
    'codex:',
    'claude',
    'gpt:abc',
    'claude:has spaces',
    'claude:has:colon',
    'claude:has/slash',
    'CLAUDE:abc',
  ])('refuses %j', (input) => {
    expect(() => parseExternalSessionRef(input)).toThrow(BoardError)
    try {
      parseExternalSessionRef(input)
    }
    catch (error) {
      expect((error as BoardError).code).toBe('board_run_session_ref_invalid')
      expect((error as BoardError).details).toEqual({ value: input })
    }
  })
})

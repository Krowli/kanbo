import { describe, expect, it } from 'vitest'

import { BoardError } from './errors'
import { formatExternalSessionRef, parseExternalSessionRef, sessionRefFromEnvironment } from './external-session-ref'

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

describe('sessionRefFromEnvironment', () => {
  it.each([
    [{ CLAUDE_CODE_SESSION_ID: 'fa78a41d-01a7-48f0-a157-eff77adad091' }, 'claude:fa78a41d-01a7-48f0-a157-eff77adad091'],
    [{ CODEX_THREAD_ID: '01a0e7c6-e289-72b3-b612-6662243c2c89' }, 'codex:01a0e7c6-e289-72b3-b612-6662243c2c89'],
    // One agent inside the other's shell: nothing says which one runs this command.
    [{ CLAUDE_CODE_SESSION_ID: 'a', CODEX_THREAD_ID: 'b' }, null],
    [{}, null],
    [{ CLAUDE_CODE_SESSION_ID: '  ' }, null],
    [{ CLAUDE_CODE_SESSION_ID: 'not a ref' }, null],
  ])('reads %j as %j', (env, ref) => {
    expect(sessionRefFromEnvironment(env)).toBe(ref)
  })
})

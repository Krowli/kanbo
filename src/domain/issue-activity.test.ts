import { describe, expect, it } from 'vitest'

import { readSystemCommentKind } from './issue-activity'

describe('system comment kind', () => {
  it('reads a comment written by an outside writer as an ordinary comment', () => {
    expect(readSystemCommentKind('system', { authorId: 'alice', sourceChatSessionId: null })).toBeNull()
  })

  it('keeps the board itself, a host runtime and every marker speaking as system', () => {
    expect(readSystemCommentKind('system', { authorId: null, sourceChatSessionId: null })).toBe('system')
    expect(readSystemCommentKind('system', { authorId: 'jarvis', sourceChatSessionId: 'chat-session-1' })).toBe('system')
    expect(readSystemCommentKind('system.run', { authorId: 'alice', sourceChatSessionId: null })).toBe('system')
  })
})

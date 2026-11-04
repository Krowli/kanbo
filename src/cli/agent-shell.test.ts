import { describe, expect, it } from 'vitest'

import { readAgentTool } from './agent-shell'

describe('the agent tool a shell belongs to', () => {
  it('names the tool whose mark the shell carries', () => {
    expect(readAgentTool({ CLAUDECODE: '1' })).toBe('claude')
    expect(readAgentTool({ GEMINI_CLI: '1' })).toBe('gemini')
    expect(readAgentTool({ CURSOR_AGENT: 'x' })).toBe('cursor')
    expect(readAgentTool({ CODEX_THREAD_ID: 't' })).toBe('codex')
  })

  it('says agent when only KANBO_ACTOR_KIND=agent says so', () => {
    expect(readAgentTool({ KANBO_ACTOR_KIND: 'agent' })).toBe('agent')
  })

  it('is null for a person, even with a tool mark', () => {
    expect(readAgentTool({})).toBeNull()
    expect(readAgentTool({ CLAUDECODE: '1', KANBO_ACTOR_KIND: 'person' })).toBeNull()
  })
})

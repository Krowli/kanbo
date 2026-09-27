import { PassThrough } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createPromptDriver } from '../../testing/prompt-driver'
import { canPrompt } from './environment'
import { createUi } from './ui'

describe('canPrompt', () => {
  beforeEach(() => {
    for (const name of ['CI', 'TERM', 'KANBO_ACTOR_KIND']) {
      vi.stubEnv(name, undefined)
    }
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('asks when both streams are a terminal, and not when either is not', () => {
    const terminal = createPromptDriver().ui
    expect(canPrompt(terminal)).toBe(true)
    expect(canPrompt(createUi({ input: terminal.input, output: new PassThrough() }))).toBe(false)
    expect(canPrompt(createUi({ input: new PassThrough(), output: terminal.output }))).toBe(false)
  })

  it.each([
    ['TERM', 'dumb'],
    ['CI', 'true'],
    ['CI', '1'],
    ['KANBO_ACTOR_KIND', 'agent'],
  ])('does not ask when %s=%s', (name, value) => {
    vi.stubEnv(name, value)
    expect(canPrompt(createPromptDriver().ui)).toBe(false)
  })

  it('asks when CI says false', () => {
    vi.stubEnv('CI', 'false')
    expect(canPrompt(createPromptDriver().ui)).toBe(true)
  })
})

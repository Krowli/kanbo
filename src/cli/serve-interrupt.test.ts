import { describe, expect, it } from 'vitest'

import { waitForInterrupt } from './commands/serve'

describe('waitForInterrupt', () => {
  it.each(['SIGINT', 'SIGTERM'] as const)('settles on %s and stops listening, so nothing is left holding the process', async (signal) => {
    const before = { int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM') }
    let settled = false
    const waiting = waitForInterrupt().then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(process.listenerCount('SIGINT')).toBe(before.int + 1)

    process.emit(signal)
    await waiting

    expect(settled).toBe(true)
    expect(process.listenerCount('SIGINT')).toBe(before.int)
    expect(process.listenerCount('SIGTERM')).toBe(before.term)
  })
})

import { describe, expect, it } from 'vitest'

import { waitForInterrupt, waitForStop } from './commands/serve'

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

describe('waitForStop', () => {
  function counts(): { int: number, term: number } {
    return { int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM') }
  }

  it('settles \'idle\' when the board page has closed, and stops listening for signals', async () => {
    const before = counts()
    let goIdle = (): void => {}
    const waiting = waitForStop(new Promise<void>((resolve) => {
      goIdle = resolve
    }))
    expect(process.listenerCount('SIGINT')).toBe(before.int + 1)

    goIdle()

    expect(await waiting).toBe('idle')
    expect(counts()).toEqual(before)
  })

  it('settles \'interrupt\' on SIGINT, and stops listening for signals', async () => {
    const before = counts()
    const waiting = waitForStop(new Promise<void>(() => {}))

    process.emit('SIGINT')

    expect(await waiting).toBe('interrupt')
    expect(counts()).toEqual(before)
  })
})

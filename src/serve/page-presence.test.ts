import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createPagePresence } from './page-presence'

describe('createPagePresence', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function make() {
    const onIdle = vi.fn()
    const presence = createPagePresence({ onIdle, now: () => Date.now() })
    return { onIdle, presence }
  }

  it('never goes idle when no page was ever opened', () => {
    const { onIdle } = make()
    vi.advanceTimersByTime(10 * 60_000)
    expect(onIdle).not.toHaveBeenCalled()
  })

  it('goes idle 5 s after the only tab closes, not before', () => {
    const { onIdle, presence } = make()
    presence.seen('a')
    presence.closed('a')
    vi.advanceTimersByTime(4_999)
    expect(onIdle).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onIdle).toHaveBeenCalledTimes(1)
  })

  it('stays up when a reload opens a new tab within the grace period', () => {
    const { onIdle, presence } = make()
    presence.seen('a')
    presence.closed('a')
    vi.advanceTimersByTime(2_000)
    presence.seen('b')
    vi.advanceTimersByTime(60_000)
    presence.seen('b')
    expect(onIdle).not.toHaveBeenCalled()
  })

  it('waits for the last of two tabs', () => {
    const { onIdle, presence } = make()
    presence.seen('a')
    presence.seen('b')
    presence.closed('a')
    vi.advanceTimersByTime(10_000)
    presence.seen('b')
    expect(onIdle).not.toHaveBeenCalled()
    presence.closed('b')
    vi.advanceTimersByTime(5_000)
    expect(onIdle).toHaveBeenCalledTimes(1)
  })

  it('drops a tab that went silent for 121 s', () => {
    const { onIdle, presence } = make()
    presence.seen('a')
    vi.advanceTimersByTime(120_000)
    expect(onIdle).not.toHaveBeenCalled()
    vi.advanceTimersByTime(11_000)
    expect(onIdle).toHaveBeenCalledTimes(1)
  })

  it('keeps a tab heard from every 60 s (a throttled hidden tab)', () => {
    const { onIdle, presence } = make()
    presence.seen('a')
    for (let minute = 0; minute < 10; minute++) {
      vi.advanceTimersByTime(60_000)
      presence.seen('a')
    }
    expect(onIdle).not.toHaveBeenCalled()
  })

  it('does not count a computer sleeping against a tab', () => {
    const { onIdle, presence } = make()
    presence.seen('a')
    vi.advanceTimersByTime(10_000)
    vi.setSystemTime(Date.now() + 30 * 60_000)
    vi.advanceTimersByTime(10_000)
    expect(onIdle).not.toHaveBeenCalled()
  })

  it('says nothing after stop()', () => {
    const { onIdle, presence } = make()
    presence.seen('a')
    presence.stop()
    presence.closed('a')
    vi.advanceTimersByTime(10 * 60_000)
    expect(onIdle).not.toHaveBeenCalled()
  })
})

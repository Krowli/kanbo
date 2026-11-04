/**
 * Who still has the board page open. The page says hello every so often and
 * goodbye when it goes; this turns that into one "everyone has gone".
 */

export interface PagePresenceOptions {
  /** Called once, when every tab that opened the page has gone. */
  onIdle: () => void
  /** How long after the last tab says goodbye to wait for a reload to come back. */
  closedGraceMs?: number
  /** A tab not heard from in this long is gone (crashed, killed). */
  staleMs?: number
  /** How often the stale check runs. */
  tickMs?: number
  now?: () => number
}

export interface PagePresence {
  seen: (tabId: string) => void
  closed: (tabId: string) => void
  /** Stop the timers; `onIdle` is never called after this. */
  stop: () => void
}

export function createPagePresence(options: PagePresenceOptions): PagePresence {
  const closedGraceMs = options.closedGraceMs ?? 5_000
  const staleMs = options.staleMs ?? 120_000
  const tickMs = options.tickMs ?? 10_000
  const now = options.now ?? Date.now
  const tabs = new Map<string, number>()
  let finished = false
  let graceTimer: ReturnType<typeof setTimeout> | null = null
  let lastTick = now()

  function stop(): void {
    finished = true
    clearInterval(ticker)
    if (graceTimer) {
      clearTimeout(graceTimer)
      graceTimer = null
    }
  }

  function idle(): void {
    if (finished) {
      return
    }
    stop()
    options.onIdle()
  }

  const ticker = setInterval(() => {
    const current = now()
    const asleep = current - lastTick > 3 * tickMs
    lastTick = current
    if (asleep) {
      // The computer slept: every tab was silent because of it, not because it left.
      for (const id of tabs.keys()) {
        tabs.set(id, current)
      }
      return
    }
    if (tabs.size === 0) {
      return
    }
    for (const [id, lastSeen] of tabs) {
      if (current - lastSeen > staleMs) {
        tabs.delete(id)
      }
    }
    if (tabs.size === 0) {
      idle()
    }
  }, tickMs)
  ticker.unref()

  return {
    seen: (tabId) => {
      if (!finished) {
        tabs.set(tabId, now())
      }
    },
    closed: (tabId) => {
      if (finished || !tabs.delete(tabId) || tabs.size > 0) {
        return
      }
      if (graceTimer) {
        clearTimeout(graceTimer)
      }
      graceTimer = setTimeout(() => {
        graceTimer = null
        if (tabs.size === 0) {
          idle()
        }
      }, closedGraceMs)
      graceTimer.unref()
    },
    stop,
  }
}

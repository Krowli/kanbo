/**
 * Tells the server this tab has the board open: hello now and every 20 s
 * (the poll pauses in a hidden tab, so it cannot be the heartbeat), goodbye
 * when the page goes. A server that was not started to watch for this answers
 * 404, and the heartbeat stops.
 */

const HEARTBEAT_MS = 20_000

/** A random id for this tab. `randomUUID` exists only on secure contexts (https, localhost); a page opened over plain http from another address falls back to random bytes. */
export function makeTabId(source: Pick<Crypto, 'getRandomValues'> & Partial<Pick<Crypto, 'randomUUID'>> = globalThis.crypto): string {
  if (typeof source.randomUUID === 'function') {
    return source.randomUUID()
  }
  return Array.from(source.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
}

export function startPresence(readToken: () => string | null): void {
  const tabId = makeTabId()
  let timer: ReturnType<typeof setInterval> | null = null

  function send(state: 'open' | 'closed'): void {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    const token = readToken()
    if (token) {
      headers.authorization = `Bearer ${token}`
    }
    fetch('/page/presence', {
      method: 'POST',
      // A goodbye sent while the page unloads is not cancelled with it.
      keepalive: true,
      headers,
      body: JSON.stringify({ tabId, state }),
    }).then((response) => {
      if (response.status === 404 && timer !== null) {
        clearInterval(timer)
        timer = null
      }
    }, () => {
      // The board poll already tells the person the server is gone.
    })
  }

  send('open')
  timer = setInterval(() => send('open'), HEARTBEAT_MS)
  window.addEventListener('pagehide', () => send('closed'))
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      send('open')
    }
  })
}

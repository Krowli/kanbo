/**
 * Tells the server this tab has the board open: hello now and every 20 s
 * (the poll pauses in a hidden tab, so it cannot be the heartbeat), goodbye
 * when the page goes. A server that was not started to watch for this answers
 * 404, and the heartbeat stops.
 */

const HEARTBEAT_MS = 20_000

export function startPresence(readToken: () => string | null): void {
  const tabId = crypto.randomUUID()
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

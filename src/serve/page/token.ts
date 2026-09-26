/**
 * The server token, as the person typed it into the page. It is kept for this
 * tab only — `sessionStorage`, never `localStorage` — and a browser that
 * refuses storage (a private window, blocked site data) just asks again after
 * a reload.
 */

const TOKEN_KEY = 'kanbo-serve-token'

export function readStoredToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY)
  }
  catch {
    return null
  }
}

export function storeToken(token: string | null): void {
  try {
    if (token) {
      sessionStorage.setItem(TOKEN_KEY, token)
    }
    else {
      sessionStorage.removeItem(TOKEN_KEY)
    }
  }
  catch {
    // Storage refused: the token lives in memory until the tab is reloaded.
  }
}

/**
 * A token handed over in the page's link — `kanbo serve` opens
 * `/#token=<token>` for the token it made up — kept like one typed in, and
 * taken out of the address bar so it is not left in view, in the history, or in
 * a link copied from there. A fragment never reached the server in the first
 * place.
 */
export function adoptTokenFromLocation(): void {
  const token = new URLSearchParams(location.hash.slice(1)).get('token')?.trim()
  if (!token) {
    return
  }
  storeToken(token)
  history.replaceState(history.state, '', `${location.pathname}${location.search}`)
}

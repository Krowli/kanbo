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

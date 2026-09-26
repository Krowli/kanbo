// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'

import { adoptTokenFromLocation, readStoredToken } from './token'

describe('adoptTokenFromLocation', () => {
  afterEach(() => {
    sessionStorage.clear()
    history.replaceState(null, '', '/')
  })

  it('keeps a token handed over in the link and takes it out of the address', () => {
    history.replaceState(null, '', '/board?x=1#token=abc_DEF-123')

    adoptTokenFromLocation()

    expect(readStoredToken()).toBe('abc_DEF-123')
    expect(location.hash).toBe('')
    expect(location.href).not.toContain('abc_DEF-123')
    expect(`${location.pathname}${location.search}`).toBe('/board?x=1')
  })

  it('leaves a stored token and the address alone when the link carries none', () => {
    sessionStorage.setItem('kanbo-serve-token', 'kept')
    history.replaceState(null, '', '/#other')

    adoptTokenFromLocation()

    expect(readStoredToken()).toBe('kept')
    expect(location.hash).toBe('#other')
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError, createBoardApi } from './api'

describe('createBoardApi', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('says the server is unreachable when fetch gets no answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }))
    const failure = await createBoardApi(() => null).version().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ApiError)
    expect(failure).toMatchObject({ code: 'server_unreachable' })
  })
})

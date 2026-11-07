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

  it('sends a bulk change as one PATCH to /issues/bulk with the token, under the project when there is one', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ updated: 2 })))
    vi.stubGlobal('fetch', fetchMock)
    const result = await createBoardApi(() => 'secret').bulkUpdate(['WOR-001', 'WOR-002'], { statusId: 'done' })
    expect(result).toEqual({ updated: 2 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/issues/bulk')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body as string)).toEqual({ issueIds: ['WOR-001', 'WOR-002'], update: { statusId: 'done' } })
    expect(init.headers).toMatchObject({ authorization: 'Bearer secret', 'content-type': 'application/json' })
    await createBoardApi(() => null, () => '/projects/p1').bulkUpdate(['WOR-001'], { priority: 'high' })
    expect((fetchMock.mock.calls[1] as unknown as [string])[0]).toBe('/projects/p1/issues/bulk')
  })
})

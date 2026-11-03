import { describe, expect, it } from 'vitest'

import { makeTabId } from './presence'

describe('makeTabId', () => {
  it('uses randomUUID where the page has it', () => {
    const source = { randomUUID: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' as const, getRandomValues: <T>(array: T) => array }
    expect(makeTabId(source)).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
  })

  it('falls back to 32 hex characters where randomUUID is missing (plain http)', () => {
    const source = {
      getRandomValues: <T extends ArrayBufferView | null>(array: T): T => {
        (array as unknown as Uint8Array).fill(171)
        return array
      },
    }
    const id = makeTabId(source)
    expect(id).toBe('ab'.repeat(16))
    expect(id).toMatch(/^[A-Za-z0-9-]+$/)
  })
})

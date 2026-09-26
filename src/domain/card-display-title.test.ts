import { describe, expect, it } from 'vitest'

import { cardDisplayTitle } from './card-display-title'

describe('cardDisplayTitle', () => {
  it('keeps a real title', () => {
    expect(cardDisplayTitle({ id: 'ALP-012', title: 'Fix the race', description: 'Details' })).toBe('Fix the race')
  })

  it('names a key-titled card by the first line of its description, markdown stripped', () => {
    expect(cardDisplayTitle({ id: 'ALP-012', title: 'ALP-012', description: '\n## Fix the **race**\nmore' })).toBe('Fix the race')
    expect(cardDisplayTitle({ id: 'ALP-012', title: 'ALP-012', description: '- [ ] first step' })).toBe('first step')
  })

  it('falls back to the key when there is no description', () => {
    expect(cardDisplayTitle({ id: 'ALP-012', title: 'ALP-012', description: null })).toBe('ALP-012')
  })
})

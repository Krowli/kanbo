import { describe, expect, it } from 'vitest'

import { LABEL_TONES, labelTone } from './labels'

describe('labelTone', () => {
  it('gives the same label the same tone every time', () => {
    expect(labelTone('frontend')).toBe(labelTone('frontend'))
    expect(labelTone('')).toBe(labelTone(''))
  })

  it('is always one of the seven tones, and spreads a set of labels over several', () => {
    const labels = ['frontend', 'backend', 'design', 'bug', 'infra', 'db', 'research', 'content', 'tests', 'billing', 'docs', 'ui']
    const tones = labels.map(labelTone)
    expect(tones.every(tone => LABEL_TONES.includes(tone))).toBe(true)
    expect(LABEL_TONES).toHaveLength(7)
    expect(new Set(tones).size).toBeGreaterThanOrEqual(4)
  })
})

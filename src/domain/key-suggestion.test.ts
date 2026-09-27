import { describe, expect, it } from 'vitest'

import { isValidCardKey, suggestCardKey } from './key-suggestion'
import { readIssuePrefix } from './numbering'

describe('suggestCardKey', () => {
  it.each([
    ['kanbo', 'KAN'],
    ['todo-list', 'TLI'],
    ['react-native-shop', 'RNS'],
    ['my_awesome_tool', 'MAT'],
    ['weather station', 'WST'],
    ['myWeatherStation', 'MWS'],
    ['APIServer', 'ASE'],
    ['my-app', 'MYX'],
    ['the-project-app', 'TPA'],
    ['the-app', 'TAP'],
    ['app', 'APP'],
    ['backend-app', 'BAC'],
    ['2048-game', 'GAM'],
    ['9lives', 'LIV'],
    ['123', 'APP'],
    ['', 'APP'],
    ['---', 'APP'],
    ['x', 'XXX'],
    ['top-10-list', 'TLI'],
    ['café-crème', 'CCR'],
    ['v2', 'V2X'],
  ])('%s → %s, which readIssuePrefix numbers cards with unchanged', (folder, key) => {
    const suggested = suggestCardKey(folder)
    expect(suggested).toBe(key)
    expect(readIssuePrefix({ id: 'w', identifier: suggested, name: suggested })).toBe(suggested)
    expect(isValidCardKey(suggested)).toBe(true)
  })

  it('accepts a letter and two letters or digits, in any case, and nothing else', () => {
    expect(['MYA', 'ab1', 'Q42'].every(isValidCardKey)).toBe(true)
    expect(['1AB', 'AB', 'ABCD', 'A-B', ''].some(isValidCardKey)).toBe(false)
  })
})

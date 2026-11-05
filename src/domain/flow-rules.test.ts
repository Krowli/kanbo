import { describe, expect, it } from 'vitest'

import { evaluateFlowRules, joinWords, readFlowRules, serializeAllowedFrom, standardFlowOf } from './flow-rules'

const NAMES = new Map([['progress', 'In Progress'], ['review', 'In Review'], ['qa', 'QA']])

describe('readFlowRules', () => {
  it('reads no list as any column and no limit, and keeps an empty list apart from no list', () => {
    expect(readFlowRules({ allowedFrom: null, wipLimit: null })).toEqual({ allowedFrom: null, wipLimit: null })
    expect(readFlowRules({ allowedFrom: '[]', wipLimit: 2 })).toEqual({ allowedFrom: [], wipLimit: 2 })
    expect(readFlowRules({ allowedFrom: '["review","qa"]', wipLimit: null })).toEqual({ allowedFrom: ['review', 'qa'], wipLimit: null })
    expect(serializeAllowedFrom(null)).toBeNull()
    expect(serializeAllowedFrom([])).toBe('[]')
    expect(serializeAllowedFrom(['review', 'qa'])).toBe('["review","qa"]')
  })
})

describe('evaluateFlowRules', () => {
  it('lets in a card from a listed column, and anything into a column without rules', () => {
    expect(evaluateFlowRules({ statusId: 'review' }, { name: 'Done' }, { allowedFrom: ['review'], wipLimit: null }, { columnNames: NAMES, cardsInColumn: 0 })).toEqual([])
    expect(evaluateFlowRules({ statusId: null }, { name: 'Done' }, { allowedFrom: null, wipLimit: null }, { columnNames: NAMES, cardsInColumn: 9 })).toEqual([])
  })

  it('refuses a card from another column, and a new card from no column, naming where cards may come from', () => {
    expect(evaluateFlowRules({ statusId: 'progress' }, { name: 'Done' }, { allowedFrom: ['review'], wipLimit: null }, { columnNames: NAMES, cardsInColumn: 0 }))
      .toEqual([{ rule: 'allowed_from', reason: 'not_allowed_from', detail: 'Done accepts cards from In Review only' }])
    expect(evaluateFlowRules({ statusId: null }, { name: 'Done' }, { allowedFrom: ['review', 'qa'], wipLimit: null }, { columnNames: NAMES, cardsInColumn: 0 })[0]?.detail)
      .toBe('Done accepts cards from In Review and QA only')
    expect(evaluateFlowRules({ statusId: 'review' }, { name: 'Done' }, { allowedFrom: [], wipLimit: null }, { columnNames: NAMES, cardsInColumn: 0 })[0]?.detail)
      .toBe('Done accepts cards from no column; only a person may put a card here')
  })

  it('counts the cards already in the column, not the one entering: a column at its limit is full', () => {
    const rules = { allowedFrom: null, wipLimit: 3 }
    expect(evaluateFlowRules({ statusId: 'todo' }, { name: 'In Progress' }, rules, { columnNames: NAMES, cardsInColumn: 2 })).toEqual([])
    expect(evaluateFlowRules({ statusId: 'todo' }, { name: 'In Progress' }, rules, { columnNames: NAMES, cardsInColumn: 3 }))
      .toEqual([{ rule: 'wip_limit', reason: 'column_full', detail: 'In Progress holds 3 of 3' }])
  })

  it('reports both rules a card breaks, where it may come from first', () => {
    const unmet = evaluateFlowRules({ statusId: 'progress' }, { name: 'Done' }, { allowedFrom: ['review'], wipLimit: 1 }, { columnNames: NAMES, cardsInColumn: 1 })
    expect(unmet.map(item => item.rule)).toEqual(['allowed_from', 'wip_limit'])
  })
})

describe('the standard flow', () => {
  const column = (name: string) => ({ name })

  it('lets Done take cards from In Review, and from QA when the board has it, in board order', () => {
    const board = [column('To Do'), column('In Review'), column('QA'), column('Done')]
    expect(standardFlowOf(board)).toEqual({ target: board[3], sources: [board[1], board[2]] })
    expect(standardFlowOf([column('In Review'), column('Done')])?.sources).toEqual([column('In Review')])
  })

  it('is nothing for a board without Done, or with nothing for Done to take cards from', () => {
    expect(standardFlowOf([column('To Do'), column('In Progress'), column('Done')])).toBeNull()
    expect(standardFlowOf([column('In Review'), column('Shipped')])).toBeNull()
  })

  it('joins words as a sentence says them', () => {
    expect([[], ['A'], ['A', 'B'], ['A', 'B', 'C']].map(words => joinWords(words))).toEqual(['', 'A', 'A and B', 'A, B and C'])
  })
})

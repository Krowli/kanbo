import { describe, expect, it } from 'vitest'

import { enterOf, placementsOf, startsWaiting } from './enter'
import { cardFixture } from './fixtures'

const board = placementsOf([
  cardFixture({ id: 'WOR-001', statusId: 'todo' }),
  cardFixture({ id: 'WOR-002', statusId: 'doing', waitingFor: 'human' }),
])

describe('enterOf', () => {
  it('moves nothing on the first render', () => {
    expect(enterOf(null, cardFixture({ id: 'WOR-001', statusId: 'todo' }))).toBeNull()
  })

  it('moves nothing for a card where it was', () => {
    expect(enterOf(board, cardFixture({ id: 'WOR-001', statusId: 'todo' }))).toBeNull()
  })

  it('says new for a card the last render did not have', () => {
    expect(enterOf(board, cardFixture({ id: 'WOR-003', statusId: 'todo' }))).toBe('new')
    expect(enterOf(new Map(), cardFixture({ id: 'WOR-003', statusId: 'todo' }))).toBe('new')
  })

  it('says moved for a card now in another column', () => {
    expect(enterOf(board, cardFixture({ id: 'WOR-001', statusId: 'doing' }))).toBe('moved')
    expect(enterOf(board, cardFixture({ id: 'WOR-001', statusId: null }))).toBe('moved')
  })
})

describe('startsWaiting', () => {
  it('is true only for a card that waits now and did not before', () => {
    expect(startsWaiting(board, cardFixture({ id: 'WOR-001', waitingFor: 'human' }))).toBe(true)
    expect(startsWaiting(board, cardFixture({ id: 'WOR-003', waitingFor: 'human' }))).toBe(true)
    expect(startsWaiting(board, cardFixture({ id: 'WOR-002', waitingFor: 'human' }))).toBe(false)
    expect(startsWaiting(board, cardFixture({ id: 'WOR-001' }))).toBe(false)
  })

  it('is false on the first render', () => {
    expect(startsWaiting(null, cardFixture({ id: 'WOR-001', waitingFor: 'human' }))).toBe(false)
  })
})

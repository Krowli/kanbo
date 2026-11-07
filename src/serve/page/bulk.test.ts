import { describe, expect, it, vi } from 'vitest'

import type { BoardApi } from './api'
import { applyBulk } from './bulk'

const apiWith = (result: Awaited<ReturnType<BoardApi['bulkUpdate']>>) => ({ bulkUpdate: vi.fn(async () => result) })

describe('applyBulk', () => {
  it('sends one write for every selected card, in the order given, and says nothing when all went in clean', async () => {
    const api = apiWith({ updated: 3 })
    const notice = await applyBulk(api, ['WOR-001', 'WOR-002', 'WOR-003'], { statusId: 'done' }, { column: 'Done' })
    expect(api.bulkUpdate).toHaveBeenCalledTimes(1)
    expect(api.bulkUpdate).toHaveBeenCalledWith(['WOR-001', 'WOR-002', 'WOR-003'], { statusId: 'done' })
    expect(notice).toBeNull()
  })

  it('sends a priority change the same way', async () => {
    const api = apiWith({ updated: 2 })
    await applyBulk(api, ['WOR-001', 'WOR-002'], { priority: 'urgent' }, {})
    expect(api.bulkUpdate).toHaveBeenCalledWith(['WOR-001', 'WOR-002'], { priority: 'urgent' })
  })

  it('lists, in one notice, the cards that went in short of the column\'s rules, and keeps the rest', async () => {
    const api = apiWith({
      updated: 3,
      unmetRules: [
        { issueId: 'WOR-002', unmet: [{ rule: 'approved', reason: 'not_approved', detail: 'a person has not approved it' }] },
        { issueId: 'WOR-003', unmet: [{ rule: 'ci_green', reason: 'no_ci', detail: 'no CI result yet' }, { rule: 'approved', reason: 'not_approved', detail: 'a person has not approved it' }] },
      ],
    })
    const notice = await applyBulk(api, ['WOR-001', 'WOR-002', 'WOR-003'], { statusId: 'done' }, { column: 'Done' })
    expect(notice).toBe('3 cards are in Done. Short of its rules: WOR-002 (a person has not approved it); WOR-003 (no CI result yet; a person has not approved it).')
  })

  it('does not call the server for an empty selection', async () => {
    const api = apiWith({ updated: 0 })
    expect(await applyBulk(api, [], { priority: 'high' }, {})).toBeNull()
    expect(api.bulkUpdate).not.toHaveBeenCalled()
  })

  it('lets a refusal through for the page to show, as nothing was written', async () => {
    const api = { bulkUpdate: vi.fn(async () => { throw new Error('refused') }) }
    await expect(applyBulk(api, ['WOR-001'], { statusId: 'done' }, {})).rejects.toThrow('refused')
  })
})

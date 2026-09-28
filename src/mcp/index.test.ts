import { describe, expect, expectTypeOf, it } from 'vitest'

import type {
  KanboCardDetailResult,
  KanboCardInclude,
  KanboCardPage,
  KanboCardQuery,
  KanboCardResult,
  KanboToolTransport,
} from './index'
import { KANBO_CARD_INCLUDES, matchesKanboCardQuery, pageOf } from './index'

/**
 * What a host implementing `KanboToolTransport` needs is exported from
 * `kanbo/mcp` — the query a `cardPage` takes, the page it answers, the parts a
 * `cardGet` includes — along with the helpers the HTTP transport builds its
 * answer with.
 */
describe('kanbo/mcp exports', () => {
  it('names the types a KanboToolTransport is written against', () => {
    expectTypeOf<Parameters<KanboToolTransport['cardPage']>[0]>().toEqualTypeOf<KanboCardQuery>()
    expectTypeOf<Awaited<ReturnType<KanboToolTransport['cardPage']>>>().toEqualTypeOf<KanboCardPage>()
    expectTypeOf<Awaited<ReturnType<KanboToolTransport['cardGet']>>>().toEqualTypeOf<KanboCardDetailResult>()
    expectTypeOf<NonNullable<Parameters<KanboToolTransport['cardGet']>[0]['include']>[number]>().toEqualTypeOf<KanboCardInclude>()
    expectTypeOf<KanboCardPage['cards'][number]>().toEqualTypeOf<KanboCardResult>()
  })

  it('exports the helpers that filter and page cards already read', () => {
    expect(KANBO_CARD_INCLUDES).toContain('subCards')
    const card = {
      id: 'WOR-001',
      number: 1,
      title: 'Über',
      description: null,
      statusId: 'status-todo',
      statusLine: null,
      waitingFor: null,
      priority: 'none' as const,
      labels: ['ui'],
      executionMode: 'worktree' as const,
      parentIssueId: null,
      updatedAt: 10,
      attemptCount: 0,
      activeRun: null,
    }
    expect(matchesKanboCardQuery(card, { text: 'über', labels: ['ui'] }, null)).toBe(true)
    expect(matchesKanboCardQuery(card, { updatedSince: 11 }, null)).toBe(false)
    expect(pageOf([{ id: 'a' } as KanboCardResult, { id: 'b' } as KanboCardResult], { offset: 1, limit: 5 }))
      .toEqual({ cards: [{ id: 'b' }], total: 2, offset: 1 })
  })
})

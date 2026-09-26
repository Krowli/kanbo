import { describe, expect, it } from 'vitest'

import type { EntryRuleFacts } from './entry-rules'
import { ENTRY_RULES, evaluateEntryRules, readChecklist, readEntryRules, serializeEntryRules } from './entry-rules'
import { BoardError } from './errors'

const NOTHING: EntryRuleFacts = { pullRequestCount: 0, latestCi: null, approval: 'none' }

describe('readChecklist', () => {
  it('counts every task item and the checked ones, in any list marker and either case of x', () => {
    const description = [
      '- [ ] one',
      '- [x] two',
      '* [X] three',
      '+ [ ] four',
      '1. [x] five',
      '2) [ ] six',
    ].join('\n')

    expect(readChecklist(description)).toEqual({ total: 6, checked: 3 })
  })

  it('counts nested items as tasks of their own', () => {
    expect(readChecklist('- [x] parent\n  - [ ] child\n    - [x] grandchild')).toEqual({ total: 3, checked: 2 })
  })

  it('leaves out anything inside a fenced code block, backticks or tildes', () => {
    const description = [
      '- [x] real',
      '```md',
      '- [ ] quoted example',
      '```',
      '~~~',
      '- [ ] another example',
      '~~~',
      '- [ ] real too',
    ].join('\n')

    expect(readChecklist(description)).toEqual({ total: 2, checked: 1 })
  })

  it('does not close a fence on a shorter or different marker', () => {
    const description = ['````', '```', '- [ ] still inside', '~~~', '````', '- [x] outside'].join('\n')

    expect(readChecklist(description)).toEqual({ total: 1, checked: 1 })
  })

  it('reads a box with nothing after it, and ignores what only looks like one', () => {
    const description = [
      '- [ ]',
      '- [x]',
      '- [] not a box',
      '- [y] not a box',
      '-[ ] no space after the marker',
      'text - [ ] mid-line',
      '- [x]done without a space',
    ].join('\n')

    expect(readChecklist(description)).toEqual({ total: 2, checked: 1 })
  })

  it('reads CRLF descriptions and an empty one', () => {
    expect(readChecklist('- [x] a\r\n- [ ] b\r\n')).toEqual({ total: 2, checked: 1 })
    expect(readChecklist(null)).toEqual({ total: 0, checked: 0 })
    expect(readChecklist('')).toEqual({ total: 0, checked: 0 })
  })
})

describe('evaluateEntryRules', () => {
  it('asks nothing of a card when the column has no rules', () => {
    expect(evaluateEntryRules({ description: null }, [], NOTHING)).toEqual({ unmet: [] })
  })

  it('wants at least one checkbox and every one checked', () => {
    const rules = ['checklist_complete'] as const
    expect(evaluateEntryRules({ description: 'no boxes here' }, rules, NOTHING).unmet)
      .toEqual([{ rule: 'checklist_complete', reason: 'no_checklist', detail: 'no checklist in the description' }])
    expect(evaluateEntryRules({ description: '- [x] a\n- [ ] b\n- [ ] c\n- [x] d\n- [x] e' }, rules, NOTHING).unmet)
      .toEqual([{ rule: 'checklist_complete', reason: 'unchecked', detail: '2 of 5 unchecked', checked: 3, total: 5 }])
    expect(evaluateEntryRules({ description: '- [x] a\n- [X] b' }, rules, NOTHING).unmet).toEqual([])
  })

  it('wants a linked pull request', () => {
    const rules = ['pull_request_linked'] as const
    expect(evaluateEntryRules({ description: null }, rules, NOTHING).unmet)
      .toEqual([{ rule: 'pull_request_linked', reason: 'no_pull_request', detail: 'no pull request linked' }])
    expect(evaluateEntryRules({ description: null }, rules, { ...NOTHING, pullRequestCount: 2 }).unmet).toEqual([])
  })

  it('wants the newest CI verdict green', () => {
    const rules = ['ci_green'] as const
    expect(evaluateEntryRules({ description: null }, rules, NOTHING).unmet)
      .toEqual([{ rule: 'ci_green', reason: 'no_ci', detail: 'no CI result yet' }])
    expect(evaluateEntryRules({ description: null }, rules, { ...NOTHING, latestCi: 'red' }).unmet)
      .toEqual([{ rule: 'ci_green', reason: 'ci_red', detail: 'CI is red' }])
    expect(evaluateEntryRules({ description: null }, rules, { ...NOTHING, latestCi: 'green' }).unmet).toEqual([])
  })

  it('wants a person\'s approval, and says what stands instead', () => {
    const rules = ['approved'] as const
    const detail = (approval: EntryRuleFacts['approval']) =>
      evaluateEntryRules({ description: null }, rules, { ...NOTHING, approval }).unmet[0]?.detail
    expect(detail('none')).toBe('not approved by a person')
    expect(detail('pending')).toBe('waiting for a person to approve')
    expect(detail('returned')).toBe('returned by a person, not approved')
    expect(detail('approved')).toBeUndefined()
  })

  it('lists every unmet rule in the column\'s order', () => {
    expect(evaluateEntryRules({ description: '- [ ] a' }, ENTRY_RULES, NOTHING).unmet.map(item => item.rule))
      .toEqual(['checklist_complete', 'pull_request_linked', 'ci_green', 'approved'])
  })
})

describe('the stored rules', () => {
  it('keeps known rules once each, in board order, and none as null', () => {
    expect(serializeEntryRules(['ci_green', 'checklist_complete', 'ci_green'])).toBe('["checklist_complete","ci_green"]')
    expect(serializeEntryRules([])).toBeNull()
    expect(serializeEntryRules(null)).toBeNull()
  })

  it('refuses a rule the board does not know, naming it', () => {
    let failure: unknown
    try {
      serializeEntryRules(['ci_green', 'tests_pass'])
    }
    catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(BoardError)
    expect((failure as BoardError).code).toBe('board_entry_rule_invalid')
    expect((failure as BoardError).details).toEqual({ rules: ['tests_pass'], allowed: [...ENTRY_RULES] })
  })

  it('reads back what was stored, and skips a rule a newer build wrote', () => {
    expect(readEntryRules({ entryRules: null })).toEqual([])
    expect(readEntryRules({ entryRules: '["approved","from_the_future","pull_request_linked"]' }))
      .toEqual(['pull_request_linked', 'approved'])
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'

import { BoardError } from '../domain/errors'
import { describeFailure, paintFailure } from './failure'
import { CliError } from './output'
import { SCHEMA_OUTDATED_MESSAGE } from './schema-guard'

describe('what a failed command says', () => {
  it('keeps the exit code and the sentence a CliError already carries', () => {
    // Any sentence at all: what is under test is that neither the code nor the
    // words are touched. This one is a guard's, so it reads like a real one.
    expect(describeFailure(new CliError(3, SCHEMA_OUTDATED_MESSAGE)))
      .toEqual({ exitCode: 3, message: SCHEMA_OUTDATED_MESSAGE })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('says a BoardError in words, with the next step and the code behind it', () => {
    vi.stubEnv('KANBO_DEBUG', '')
    expect(describeFailure(new BoardError('issue_status_not_found', { statusName: 'foo', normalizedStatusName: 'foo' })))
      .toEqual({
        exitCode: 1,
        code: 'issue_status_not_found',
        message: 'No column "foo" on this board.\n  Next: kanbo columns list  [issue_status_not_found]',
      })
  })

  it('puts the code on the same line when there is no next step', () => {
    vi.stubEnv('KANBO_DEBUG', '')
    expect(describeFailure(new BoardError('issue_parent_self_reference', { issueId: 'MYA-1', parentIssueId: 'MYA-1' })).message)
      .toBe('A card can\'t be put under itself.  [issue_parent_self_reference]')
  })

  it('prints the details only with KANBO_DEBUG=1', () => {
    vi.stubEnv('KANBO_DEBUG', '1')
    expect(describeFailure(new BoardError('board_approval_requires_user', { issueId: 'MYA-1', actorKind: 'agent' })).message)
      .toBe([
        'Only a person can approve a card.',
        '  Next: run it in your own terminal, or on the board page (kanbo serve)  [board_approval_requires_user]',
        '  Details: {"issueId":"MYA-1","actorKind":"agent"}',
      ].join('\n'))
  })

  it('falls back to the code and its details for a code it has no words for', () => {
    const unknown = new BoardError('issue_not_found', { issueId: 'x' })
    ;(unknown as { code: string }).code = 'board_something_new'
    expect(describeFailure(unknown).message).toBe('board_something_new {"issueId":"x"}')
  })

  it('dims the code in a terminal and colours the rest', () => {
    const painted = paintFailure({ exitCode: 1, code: 'issue_not_found', message: 'No card "X" here.\n  Next: kanbo card list  [issue_not_found]' })
    expect(painted.replace(/\x1B\[\d+m/g, '')).toBe('No card "X" here.\n  Next: kanbo card list  [issue_not_found]')
  })

  it('prints what was underneath, indented, because the wrapper alone says nothing', () => {
    // What a driver hands back: the statement that failed, with the reason it
    // failed one link down.
    const connection = new Error('connect ECONNREFUSED 127.0.0.1:5432')
    const failed = new Error('Failed query: create schema "drizzle"', { cause: connection })

    expect(describeFailure(failed)).toEqual({
      exitCode: 1,
      message: 'Failed query: create schema "drizzle"\n  Caused by: connect ECONNREFUSED 127.0.0.1:5432',
    })
  })

  it('never lets a password through, however deep it was buried', () => {
    const cause = new Error('no pg_hba.conf entry for postgres://user:secret@host:5432/db')
    const middle = new Error('write CONNECTION_CLOSED', { cause })
    const failure = describeFailure(new Error('Failed query: select 1', { cause: middle }))

    expect(failure.message).toContain('postgres://user:***@host:5432/db')
    expect(failure.message).not.toContain('secret')
  })

  it('stops following a chain that has stopped explaining anything', () => {
    const looping = new Error('round')
    ;(looping as { cause?: unknown }).cause = looping

    // Bounded, because `cause` is an ordinary property and nothing stops it
    // pointing back at the error it came from.
    expect(describeFailure(looping).message.split('\n')).toHaveLength(6)
  })
})

import { describe, expect, it } from 'vitest'

import { BoardError } from '../domain/errors'
import { describeFailure } from './failure'
import { CliError } from './output'
import { SCHEMA_OUTDATED_MESSAGE } from './schema-guard'

describe('what a failed command says', () => {
  it('keeps the exit code and the sentence a CliError already carries', () => {
    // Any sentence at all: what is under test is that neither the code nor the
    // words are touched. This one is a guard's, so it reads like a real one.
    expect(describeFailure(new CliError(3, SCHEMA_OUTDATED_MESSAGE)))
      .toEqual({ exitCode: 3, message: SCHEMA_OUTDATED_MESSAGE })
  })

  it('names the rule a BoardError broke, with the value that broke it', () => {
    expect(describeFailure(new BoardError('board_approval_requires_user', { actor: 'agent' })))
      .toEqual({ exitCode: 1, message: 'board_approval_requires_user {"actor":"agent"}' })
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

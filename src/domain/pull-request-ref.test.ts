import { describe, expect, it } from 'vitest'

import { BoardError } from './errors'
import { parsePullRequestRef } from './pull-request-ref'

describe('parsePullRequestRef', () => {
  it.each([
    ['https://github.com/octo/repo/pull/42', 'octo', 'repo', 42],
    ['https://github.com/octo/repo/pull/42/', 'octo', 'repo', 42],
    ['https://github.com/octo/repo/pull/42/files', 'octo', 'repo', 42],
    ['https://github.com/octo/repo/pull/42#issuecomment-1', 'octo', 'repo', 42],
    ['https://www.github.com/octo-org/my.repo_1/pull/7?w=1', 'octo-org', 'my.repo_1', 7],
    ['  octo/repo#42 ', 'octo', 'repo', 42],
    ['https://github.com/octo_emu/repo/pull/5', 'octo_emu', 'repo', 5],
    ['octo_emu/repo#5', 'octo_emu', 'repo', 5],
  ])('reads %s', (input, owner, repo, number) => {
    expect(parsePullRequestRef(input)).toEqual({
      owner,
      repo,
      number,
      url: `https://github.com/${owner}/${repo}/pull/${number}`,
    })
  })

  it('lower-cases owner and repo — GitHub names are case-insensitive (ruling 4-6)', () => {
    expect(parsePullRequestRef('https://github.com/Acme/Repo/pull/7')).toEqual({
      owner: 'acme',
      repo: 'repo',
      number: 7,
      url: 'https://github.com/acme/repo/pull/7',
    })
    expect(parsePullRequestRef('Acme/Repo#7')).toEqual({
      owner: 'acme',
      repo: 'repo',
      number: 7,
      url: 'https://github.com/acme/repo/pull/7',
    })
  })

  it.each([
    'https://github.com/octo/repo/issues/42',
    'https://github.com/octo/repo/commit/abc',
    'https://gitlab.com/octo/repo/pull/42',
    'http://github.com/octo/repo/pull/42',
    'https://github.com/octo/repo/pull/0',
    'https://github.com/octo/repo/pull/99999999999',
    'https://github.com/octo/../pull/1',
    'octo/repo#',
    '#42',
    '42',
    '',
  ])('refuses %j', (input) => {
    expect(() => parsePullRequestRef(input)).toThrow(BoardError)
    try {
      parsePullRequestRef(input)
    }
    catch (error) {
      expect((error as BoardError).code).toBe('board_pull_request_invalid')
      expect((error as BoardError).details).toEqual({ value: input })
    }
  })
})

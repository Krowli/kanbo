import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { BoardStore } from '../board-store'
import { BoardError } from '../domain/errors'
import type { BoardWorkspaceIdentity } from '../domain/numbering'
import type { TestBoardStore } from '../testing/board-stores'
import { BOARD_STORE_FACTORIES } from '../testing/board-stores'
import { createCard } from './cards'
import { readChangeSeq } from './change-seq'
import { linkPullRequest, listPullRequests, unlinkPullRequest } from './pull-requests'
import type { BoardActor } from './types'
import { BOARD_ACTOR } from './types'

const WORKSPACE: BoardWorkspaceIdentity = { id: 'workspace', identifier: 'WOR', name: 'Workspace' }
const USER: BoardActor = { kind: 'user', id: '__self__' }
/** An agent no app launched: a `kanbo` shell, stored as the system with a name. */
const EXTERNAL: BoardActor = { kind: 'external', id: 'alice' }

describe.each(BOARD_STORE_FACTORIES)('card pull requests on $name', (factory) => {
  let board: TestBoardStore
  let store: BoardStore

  beforeEach(async () => {
    board = await factory.open([{ id: 'workspace', identifier: 'WOR' }])
    store = board.store
  })

  afterEach(async () => {
    await board.dispose()
  })

  it('links a pull request by URL, files it under who linked it, and writes no comment', async () => {
    const card = await createCard(store, { workspace: WORKSPACE, title: 'Card' }, USER)
    const before = await readChangeSeq(store)

    const link = await linkPullRequest(store, card.id, 'https://github.com/octo/repo/pull/42/files', EXTERNAL)

    expect(link).toMatchObject({
      issueId: card.id,
      owner: 'octo',
      repo: 'repo',
      number: 42,
      url: 'https://github.com/octo/repo/pull/42',
      createdByKind: 'system',
      createdById: 'alice',
    })
    expect(await readChangeSeq(store)).toBe(before + 1)
    expect(await store.comments.listByIssue(card.id)).toEqual([])
    expect(await listPullRequests(store, card.id)).toEqual([link])
  })

  it('hands back the standing link for a pull request the card already names, and leaves the board version alone', async () => {
    const card = await createCard(store, { workspace: WORKSPACE, title: 'Card' }, USER)
    const first = await linkPullRequest(store, card.id, 'https://github.com/octo/repo/pull/42', USER)
    const version = await readChangeSeq(store)

    const again = await linkPullRequest(store, card.id, 'octo/repo#42', EXTERNAL)

    expect(again).toEqual(first)
    expect(await readChangeSeq(store)).toBe(version)
    expect(await listPullRequests(store, card.id)).toHaveLength(1)
  })

  it('treats a mixed-case owner/repo as the same pull request (ruling 4-6)', async () => {
    const card = await createCard(store, { workspace: WORKSPACE, title: 'Card' }, USER)
    const first = await linkPullRequest(store, card.id, 'https://github.com/Acme/Repo/pull/7', USER)
    expect(first).toMatchObject({ owner: 'acme', repo: 'repo', number: 7 })
    const version = await readChangeSeq(store)

    const again = await linkPullRequest(store, card.id, 'acme/repo#7', EXTERNAL)

    expect(again).toEqual(first)
    expect(await readChangeSeq(store)).toBe(version)
    expect(await listPullRequests(store, card.id)).toHaveLength(1)
  })

  it('refuses what is not a GitHub pull request before touching the board', async () => {
    const card = await createCard(store, { workspace: WORKSPACE, title: 'Card' }, USER)
    const version = await readChangeSeq(store)

    await expect(linkPullRequest(store, card.id, 'https://github.com/octo/repo/issues/42', USER))
      .rejects
      .toMatchObject({ code: 'board_pull_request_invalid' })
    expect(await readChangeSeq(store)).toBe(version)
  })

  it('refuses a card the board does not have', async () => {
    await expect(linkPullRequest(store, 'WOR-404', 'octo/repo#1', USER)).rejects.toMatchObject({ code: 'issue_not_found' })
    await expect(listPullRequests(store, 'WOR-404')).rejects.toMatchObject({ code: 'issue_not_found' })
  })

  it('unlinks a pull request, and says so when the card names no such link', async () => {
    const card = await createCard(store, { workspace: WORKSPACE, title: 'Card' }, USER)
    const other = await createCard(store, { workspace: WORKSPACE, title: 'Other' }, USER)
    const link = await linkPullRequest(store, card.id, 'octo/repo#42', USER)

    const failure = await unlinkPullRequest(store, other.id, link.id, USER).then(() => undefined, (error: Error) => error)
    expect(failure).toBeInstanceOf(BoardError)
    expect(failure).toMatchObject({ code: 'board_pull_request_not_found', details: { issueId: other.id, linkId: link.id } })

    const version = await readChangeSeq(store)
    expect(await unlinkPullRequest(store, card.id, link.id, USER)).toEqual(link)
    expect(await readChangeSeq(store)).toBe(version + 1)
    expect(await listPullRequests(store, card.id)).toEqual([])
  })

  describe('who may unlink a link (ruling 4-8)', () => {
    const AGENT: BoardActor = { kind: 'agent', id: 'agent-1' }
    const OTHER_AGENT: BoardActor = { kind: 'agent', id: 'agent-2' }

    it('lets an agent unlink the link it made itself', async () => {
      const card = await createCard(store, { workspace: WORKSPACE, title: 'Card' }, USER)
      const link = await linkPullRequest(store, card.id, 'octo/repo#1', AGENT)

      expect(await unlinkPullRequest(store, card.id, link.id, AGENT)).toEqual(link)
      expect(await listPullRequests(store, card.id)).toEqual([])
    })

    it('refuses an agent unlinking a link a person made', async () => {
      const card = await createCard(store, { workspace: WORKSPACE, title: 'Card' }, USER)
      const link = await linkPullRequest(store, card.id, 'octo/repo#2', USER)

      await expect(unlinkPullRequest(store, card.id, link.id, AGENT))
        .rejects
        .toMatchObject({ code: 'board_pull_request_not_yours', details: { issueId: card.id, linkId: link.id } })
      expect(await listPullRequests(store, card.id)).toEqual([link])
    })

    it('refuses an agent unlinking another agent\'s link', async () => {
      const card = await createCard(store, { workspace: WORKSPACE, title: 'Card' }, USER)
      const link = await linkPullRequest(store, card.id, 'octo/repo#3', AGENT)

      await expect(unlinkPullRequest(store, card.id, link.id, OTHER_AGENT))
        .rejects
        .toMatchObject({ code: 'board_pull_request_not_yours' })
    })

    it('refuses an external actor unlinking another external actor\'s link, by id', async () => {
      const card = await createCard(store, { workspace: WORKSPACE, title: 'Card' }, USER)
      const link = await linkPullRequest(store, card.id, 'octo/repo#4', EXTERNAL)

      await expect(unlinkPullRequest(store, card.id, link.id, { kind: 'external', id: 'bob' }))
        .rejects
        .toMatchObject({ code: 'board_pull_request_not_yours' })
      expect(await unlinkPullRequest(store, card.id, link.id, EXTERNAL)).toEqual(link)
    })

    it('lets a person unlink any link', async () => {
      const card = await createCard(store, { workspace: WORKSPACE, title: 'Card' }, USER)
      const link = await linkPullRequest(store, card.id, 'octo/repo#5', AGENT)

      expect(await unlinkPullRequest(store, card.id, link.id, USER)).toEqual(link)
    })

    it('lets the board\'s own actor unlink any link, the way the watcher drops a gone pull request', async () => {
      const card = await createCard(store, { workspace: WORKSPACE, title: 'Card' }, USER)
      const link = await linkPullRequest(store, card.id, 'octo/repo#6', AGENT)

      expect(await unlinkPullRequest(store, card.id, link.id, BOARD_ACTOR)).toEqual(link)
    })
  })
})

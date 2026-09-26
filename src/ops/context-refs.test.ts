import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { BoardStore } from '../board-store'
import type { BoardWorkspaceIdentity } from '../domain/numbering'
import type { TestBoardStore } from '../testing/board-stores'
import { BOARD_STORE_FACTORIES } from '../testing/board-stores'
import { createCard } from './cards'
import { addContextRef, removeContextRef } from './context-refs'
import type { BoardActor } from './types'

const WORKSPACE: BoardWorkspaceIdentity = { id: 'workspace', identifier: 'WOR', name: 'Workspace' }
const AGENT: BoardActor = { kind: 'agent', id: 'agent-1', chatSessionId: 'chat-1' }

describe.each(BOARD_STORE_FACTORIES)('context refs on $name', (factory) => {
  let board: TestBoardStore
  let store: BoardStore

  beforeEach(async () => {
    board = await factory.open([{ id: 'workspace', identifier: 'WOR' }])
    store = board.store
  })

  afterEach(async () => {
    await board.dispose()
  })

  it('appends and removes refs by position, recording every change under the actor', async () => {
    const card = await createCard(store, { workspace: WORKSPACE, title: 'Card' }, AGENT)

    await addContextRef(store, card.id, 'docs/a.md', AGENT)
    await addContextRef(store, card.id, 'docs/b.md', AGENT)
    const removed = await removeContextRef(store, card.id, 0, AGENT)

    expect(removed.contextRefs).toBe('["docs/b.md"]')
    expect((await store.fieldChanges.listByIssue(card.id)).map(change => [change.fromValue, change.toValue, change.actorId, change.sourceChatSessionId]))
      .toEqual([
        ['[]', '["docs/a.md"]', 'agent-1', 'chat-1'],
        ['["docs/a.md"]', '["docs/a.md","docs/b.md"]', 'agent-1', 'chat-1'],
        ['["docs/a.md","docs/b.md"]', '["docs/b.md"]', 'agent-1', 'chat-1'],
      ])
  })

  it('refuses a position the card has no ref at, and a card the board does not hold', async () => {
    const card = await createCard(store, { workspace: WORKSPACE, title: 'Card' }, AGENT)
    await addContextRef(store, card.id, 'docs/a.md', AGENT)

    await expect(removeContextRef(store, card.id, 1, AGENT)).rejects.toMatchObject({ code: 'issue_context_ref_invalid_index', details: { issueId: card.id, index: 1 } })
    await expect(removeContextRef(store, card.id, -1, AGENT)).rejects.toMatchObject({ code: 'issue_context_ref_invalid_index' })
    await expect(addContextRef(store, 'WOR-404', 'x', AGENT)).rejects.toMatchObject({ code: 'issue_not_found' })
    expect((await store.issues.findById(card.id))?.contextRefs).toBe('["docs/a.md"]')
  })
})

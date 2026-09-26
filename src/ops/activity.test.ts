import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BoardStore } from '../board-store'
import type { BoardWorkspaceIdentity } from '../domain/numbering'
import type { TestBoardStore } from '../testing/board-stores'
import { BOARD_STORE_FACTORIES } from '../testing/board-stores'
import type { IssueActivityResolver } from './activity'
import { listActivity, listFieldChanges } from './activity'
import { addComment, approve, createCard, updateCard } from './cards'
import { createMilestone } from './sprints'
import type { BoardActor } from './types'

const WORKSPACE: BoardWorkspaceIdentity = { id: 'workspace', identifier: 'WOR', name: 'Workspace' }
const USER: BoardActor = { kind: 'user', id: '__self__' }
const AGENT: BoardActor = { kind: 'agent', id: 'agent-1' }

/** A host that knows one workspace and one agent, and says who an actor is by kind and id. */
const RESOLVER: IssueActivityResolver = {
  workspaceById: new Map([['workspace', { id: 'workspace', name: 'Workspace' }]]),
  resolveActor: async actor => ({ kind: actor.kind, id: actor.id, displayName: `${actor.kind}:${actor.id}`, avatarUrl: null, label: null }),
  resolveAgentName: async agentId => agentId === 'agent-1' ? 'Claude' : null,
}

describe.each(BOARD_STORE_FACTORIES)('activity on $name', (factory) => {
  let board: TestBoardStore
  let store: BoardStore

  beforeEach(async () => {
    board = await factory.open([{ id: 'workspace', identifier: 'WOR' }])
    store = board.store
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await board.dispose()
  })

  it('shows the creation, then changes, then comments of the same second, and hides the fields the card already says', async () => {
    // One second for everything: only the kind can order them.
    vi.spyOn(Date, 'now').mockReturnValue(1_767_225_600_000)
    const card = await createCard(store, { workspace: WORKSPACE, title: 'Card' }, USER)
    await addComment(store, { issueId: card.id, content: 'on it' }, AGENT)
    await updateCard(store, card.id, { priority: 'high', executionMode: 'main', order: 5 }, AGENT)

    const feed = await listActivity(store, card.id, RESOLVER)

    expect(feed.map(item => item.kind)).toEqual(['created', 'field-change', 'comment'])
    expect(feed[0].actor.displayName).toBe('user:__self__')
    expect(feed[1]).toMatchObject({
      actor: { displayName: 'agent:agent-1' },
      fieldChange: { action: 'changed-field', field: 'priority', fromValue: { kind: 'token', token: 'priority-none' }, toValue: { kind: 'token', token: 'priority-high' } },
    })
    expect(feed[2].comment).toEqual({ content: 'on it', systemKind: null })
    // Hidden from the feed, still in the history.
    expect((await listFieldChanges(store, card.id)).map(change => change.field).toSorted()).toEqual(['executionMode', 'order', 'priority'])
  })

  it('names what a change points at through the board and the host, and a board marker under no author', async () => {
    const milestone = await createMilestone(store, { workspaceId: WORKSPACE.id, title: 'Sprint 1' })
    const card = await createCard(store, { workspace: WORKSPACE, title: 'Card' }, USER)
    await updateCard(store, card.id, { milestoneId: milestone.id, assigneeKind: 'agent', assigneeId: 'agent-1', title: 'Renamed', description: 'Now it says' }, USER)
    await approve(store, card.id, {}, USER)

    const feed = await listActivity(store, card.id, RESOLVER)
    const change = (field: string) => feed.find(item => item.fieldChange?.field === field)?.fieldChange

    expect(change('milestone')?.toValue).toEqual({ kind: 'text', text: 'Sprint 1' })
    expect(change('assignee')?.toValue).toEqual({ kind: 'text', text: 'Claude' })
    expect(change('title')).toMatchObject({ action: 'renamed-issue', toValue: { kind: 'text', text: 'Renamed' } })
    expect(change('description')).toEqual({ action: 'added-description', field: 'description', fromValue: null, toValue: null })
    expect(feed.find(item => item.kind === 'comment')).toMatchObject({ actor: { kind: 'system', id: null }, comment: { systemKind: 'system' } })
  })

  it('refuses a card the board does not hold', async () => {
    await expect(listActivity(store, 'WOR-404', RESOLVER)).rejects.toMatchObject({ code: 'issue_not_found' })
    await expect(listFieldChanges(store, 'WOR-404')).rejects.toMatchObject({ code: 'issue_not_found' })
  })
})

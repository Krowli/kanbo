import { randomUUID } from 'node:crypto'

import type { BoardStore } from '../board-store'
import { BoardError } from '../domain/errors'
import { currentUnixSeconds } from '../domain/time'
import type { Issue, IssueRelation } from '../sqlite/schema'
import type { BoardWriteScope } from './change-seq'
import { runBoardWrite } from './change-seq'
import { requireCard } from './types'

/** The card on the other end of an edge, as much of it as a relation row shows. */
export type IssueRelationCounterpart = Pick<Issue, 'id' | 'workspaceId' | 'number' | 'title' | 'statusId' | 'priority'>

/** An edge as seen from one of the two cards it touches. */
export type IssueRelationView = IssueRelation & {
  /** Orientation of the edge relative to the issue the relations were listed for. */
  direction: 'outgoing' | 'incoming'
  /** The issue on the other end of the edge, resolved across workspaces. */
  counterpart: IssueRelationCounterpart | null
}

/** A new edge between two cards. */
export interface CreateRelationInput {
  sourceIssueId: string
  targetIssueId: string
  type: IssueRelation['type']
}

/**
 * Every edge touching the card, in either direction, each with the card on its
 * other end. A counterpart the board no longer holds comes back as `null`
 * rather than dropping the edge.
 */
export async function listRelations(store: BoardStore, issueId: string): Promise<IssueRelationView[]> {
  await requireCard(store, issueId)
  const rows = await store.relations.listByIssue(issueId)
  const counterpartIds = [...new Set(rows.map(row => row.sourceIssueId === issueId ? row.targetIssueId : row.sourceIssueId))]
  const counterpartRows = counterpartIds.length > 0 ? await store.issues.listByIds(counterpartIds) : []
  const counterpartsById = new Map<string, IssueRelationCounterpart>(counterpartRows.map(row => [row.id, {
    id: row.id,
    workspaceId: row.workspaceId,
    number: row.number,
    title: row.title,
    statusId: row.statusId,
    priority: row.priority,
  }]))

  return rows.map((row) => {
    const outgoing = row.sourceIssueId === issueId
    return {
      ...row,
      direction: outgoing ? 'outgoing' : 'incoming',
      counterpart: counterpartsById.get(outgoing ? row.targetIssueId : row.sourceIssueId) ?? null,
    }
  })
}

/**
 * Draw an edge between two cards of this board.
 *
 * A card is never related to itself, and both cards must be on the board. The
 * same edge drawn twice is one edge: the standing row comes back and nothing is
 * written — `relates_to` is symmetric, so the reversed pair is the same edge,
 * while a directed type keeps its orientation.
 */
export async function createRelation<TStore extends BoardStore>(
  store: TStore,
  input: CreateRelationInput,
  scope?: BoardWriteScope<TStore>,
): Promise<IssueRelation> {
  if (input.sourceIssueId === input.targetIssueId) {
    throw new BoardError('issue_relation_self_reference', { issueId: input.sourceIssueId })
  }

  return await runBoardWrite(store, async ({ tx }) => {
    await requireCard(tx, input.sourceIssueId)
    await requireCard(tx, input.targetIssueId)
    const duplicate = await tx.relations.findMatching(input)
    if (duplicate) {
      return duplicate
    }
    return await tx.relations.create({
      id: randomUUID(),
      sourceIssueId: input.sourceIssueId,
      targetIssueId: input.targetIssueId,
      type: input.type,
      createdAt: currentUnixSeconds(),
    })
  }, scope)
}

/** Remove one edge, or say the board holds no such edge. */
export async function deleteRelation<TStore extends BoardStore>(
  store: TStore,
  relationId: string,
  scope?: BoardWriteScope<TStore>,
): Promise<void> {
  await runBoardWrite(store, async ({ tx }) => {
    if (!await tx.relations.findById(relationId)) {
      throw new BoardError('issue_relation_not_found', { relationId })
    }
    await tx.relations.delete(relationId)
  }, scope)
}

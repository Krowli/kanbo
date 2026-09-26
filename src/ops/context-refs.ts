import { z } from 'zod'

import type { BoardStore } from '../board-store'
import { BoardError } from '../domain/errors'
import { currentUnixSeconds } from '../domain/time'
import type { Issue } from '../sqlite/schema'
import { recordFieldChanges } from './cards'
import type { BoardWriteScope } from './change-seq'
import { runBoardWrite } from './change-seq'
import type { BoardActor } from './types'
import { requireCard } from './types'

const ContextRefsJsonSchema = z.string()
  .transform(raw => JSON.parse(raw))
  .pipe(z.array(z.string()))

/** Add a context ref at the end of the card's list, recording the change in its history. */
export async function addContextRef<TStore extends BoardStore>(
  store: TStore,
  issueId: string,
  ref: string,
  actor: BoardActor,
  scope?: BoardWriteScope<TStore>,
): Promise<Issue> {
  return await runBoardWrite(store, async ({ tx }) => {
    const card = await requireCard(tx, issueId)
    const refs = ContextRefsJsonSchema.parse(card.contextRefs)
    refs.push(ref)
    return await replaceContextRefs(tx, card, refs, actor)
  }, scope)
}

/** Remove the card's context ref at `index`, or say there is none there. */
export async function removeContextRef<TStore extends BoardStore>(
  store: TStore,
  issueId: string,
  index: number,
  actor: BoardActor,
  scope?: BoardWriteScope<TStore>,
): Promise<Issue> {
  return await runBoardWrite(store, async ({ tx }) => {
    const card = await requireCard(tx, issueId)
    const refs = ContextRefsJsonSchema.parse(card.contextRefs)
    if (index < 0 || index >= refs.length) {
      throw new BoardError('issue_context_ref_invalid_index', { issueId, index })
    }
    refs.splice(index, 1)
    return await replaceContextRefs(tx, card, refs, actor)
  }, scope)
}

async function replaceContextRefs(store: BoardStore, card: Issue, refs: string[], actor: BoardActor): Promise<Issue> {
  const updates = { contextRefs: JSON.stringify(refs), updatedAt: currentUnixSeconds() }
  await recordFieldChanges(store, card, updates, actor)
  await store.contextRefs.replace(card.id, updates.contextRefs, updates.updatedAt)
  return await requireCard(store, card.id)
}

import type { BoardStore } from '../board-store'
import type { BoardWorkspaceIdentity } from '../domain/numbering'
import { createBoardOps } from '../ops'
import { ensureDefaultColumns } from '../ops/columns'
import type { BoardActor } from '../ops/types'

/**
 * A board shaped like one in use, for the query-count tests and the bench:
 * cards spread over the standard columns, each with a description and two
 * comments; every card in progress has a run going, every Done card a finished
 * one, and every card in review waits for a person.
 *
 * Written through the operations, not straight into the tables, so the rows —
 * numbering, field history, the comments a run leaves — are the ones a real
 * board carries.
 */

export const SEED_WORKSPACE: BoardWorkspaceIdentity = { id: 'workspace', identifier: 'WOR', name: 'Workspace' }

const PERSON: BoardActor = { kind: 'user', id: '__self__' }
const AGENT: BoardActor = { kind: 'agent', id: 'claude' }

/** Where card `index` goes, out of every 20: Backlog 4, To Do 6, In Progress 3, In Review 2, Done 5. */
function columnOf(index: number): string {
  const slot = index % 20
  if (slot < 4) {
    return 'Backlog'
  }
  if (slot < 10) {
    return 'To Do'
  }
  if (slot < 13) {
    return 'In Progress'
  }
  if (slot < 15) {
    return 'In Review'
  }
  return 'Done'
}

const DESCRIPTION = 'The settings page loads every preference on open and saves each one as it changes. '
  + 'Group them by section, keep the keyboard order, and write a test for the save path. '
  + 'Acceptance: nothing is lost on reload, and the page opens in under a second.'

/** Put `count` cards on the workspace's board, starting the columns first when it has none. */
export async function seedBoard(store: BoardStore, count: number, workspace = SEED_WORKSPACE): Promise<void> {
  const ops = createBoardOps(store)
  await ensureDefaultColumns(store, workspace.id)
  for (let index = 0; index < count; index++) {
    const column = columnOf(index)
    const card = await ops.createCard({
      workspace,
      title: `Task ${index + 1}: tidy the settings page, section ${index % 7}`,
      description: DESCRIPTION,
      statusName: column,
      labels: index % 3 === 0 ? ['frontend'] : [],
    }, PERSON)
    await ops.addComment({ issueId: card.id, content: 'Started reading the code; the save path is in settings/store.ts.' }, AGENT)
    await ops.addComment({ issueId: card.id, content: 'Please keep the old keyboard shortcuts working.' }, PERSON)
    if (column === 'In Progress') {
      await ops.startRun(card.id, { agentName: 'claude' }, AGENT)
      await ops.setStatusLine(card.id, 'writing the section headers; tests next', AGENT)
    }
    else if (column === 'Done') {
      const run = await ops.startRun(card.id, { agentName: 'claude' }, AGENT)
      await ops.finishRun(run.id, { state: 'finished' }, AGENT)
    }
    else if (column === 'In Review') {
      await ops.waitApproval(card.id, { statusLine: 'done, please check the page' }, AGENT)
    }
  }
}

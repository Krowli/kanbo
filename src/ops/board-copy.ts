import type { BoardStore } from '../board-store'
import { BoardError } from '../domain/errors'
import { currentUnixSeconds } from '../domain/time'
import type {
  Issue,
  IssueComment,
  IssueFieldChange,
  IssueMilestone,
  IssuePullRequest,
  IssueRelation,
  IssueRun,
  IssueStatus,
} from '../sqlite/schema'

/** How many rows of each kind a copy wrote into the target board. */
export interface BoardCopyCounts {
  statuses: number
  milestones: number
  issues: number
  comments: number
  runs: number
  relations: number
  fieldChanges: number
  /** Cards that carried refs, not rows: context refs are a column on the card. */
  contextRefs: number
  pullRequests: number
}

/** Everything one workspace has on a board, read before anything is written. */
export interface BoardSlice {
  statuses: IssueStatus[]
  milestones: IssueMilestone[]
  /** In an order where a card's parent always comes before it. */
  issues: Issue[]
  comments: IssueComment[]
  runs: IssueRun[]
  relations: IssueRelation[]
  fieldChanges: IssueFieldChange[]
  pullRequests: IssuePullRequest[]
  /** What reading it had to leave behind, said to a person. */
  warnings: string[]
}

/** Nothing copied — what a move that had nothing to move reports. */
export function emptyCopyCounts(): BoardCopyCounts {
  return { statuses: 0, milestones: 0, issues: 0, comments: 0, runs: 0, relations: 0, fieldChanges: 0, contextRefs: 0, pullRequests: 0 }
}

/**
 * Everything the workspace has on this board, read in one pass before a single
 * row is written anywhere.
 *
 * Links are collected by id because an edge is listed by both of the cards it
 * touches, and one reaching a card outside this workspace is left behind rather
 * than copied: the target holds this workspace's board and nothing else, so the
 * far end of that edge is not there to point at.
 */
export async function readBoardSlice(from: BoardStore, workspaceId: string): Promise<BoardSlice> {
  const warnings: string[] = []
  const statuses = await from.statuses.listByWorkspace(workspaceId)
  const milestones = await from.milestones.listByWorkspace(workspaceId)
  const issues = orderParentsFirst(await from.issues.listByWorkspace(workspaceId))
  const issueIds = new Set(issues.map(issue => issue.id))

  const comments: IssueComment[] = []
  const runs: IssueRun[] = []
  const relations = new Map<string, IssueRelation>()
  const fieldChanges: IssueFieldChange[] = []
  const pullRequests: IssuePullRequest[] = []
  const skippedRelations = new Set<string>()
  for (const issue of issues) {
    // The store's own order — insertion order on either engine, for runs, for
    // comments and for field changes alike — is the order they are written back
    // in. That is what keeps an attempt number, and the last word on a card,
    // reading the same after the move as before it.
    comments.push(...await from.comments.listByIssue(issue.id))
    runs.push(...await from.runs.listByIssue(issue.id))
    for (const relation of await from.relations.listByIssue(issue.id)) {
      if (issueIds.has(relation.sourceIssueId) && issueIds.has(relation.targetIssueId)) {
        relations.set(relation.id, relation)
        continue
      }
      skippedRelations.add(relation.id)
    }
    fieldChanges.push(...await from.fieldChanges.listByIssue(issue.id))
    pullRequests.push(...await from.pullRequests.listByIssue(issue.id))
  }
  if (skippedRelations.size > 0) {
    warnings.push(`${skippedRelations.size} links to cards in other workspaces were not moved`)
  }

  return { statuses, milestones, issues, comments, runs, relations: [...relations.values()], fieldChanges, pullRequests, warnings }
}

/**
 * Write a slice into the target board, in one transaction, and say what was
 * written and what a person should know about it — the slice's own warnings
 * first.
 *
 * It is idempotent by id. A row the target already has is left exactly as it
 * is and counted as already present, so a copy interrupted half-way is finished
 * by running it again, and a second run of a finished one copies nothing. A
 * clash that is not the same row — a column name or a card number the target
 * holds under another id — refuses the whole copy before its first insert
 * (`board_copy_conflict`, ruling 3-55).
 */
export async function writeBoardSlice(
  to: BoardStore,
  slice: BoardSlice,
  workspaceId: string,
): Promise<{ copied: BoardCopyCounts, warnings: string[] }> {
  const warnings = [...slice.warnings]
  const copied = emptyCopyCounts()
  let alreadyPresent = 0

  await to.transaction(async (tx) => {
    await assertTheCopyFits(tx, slice, workspaceId)

    for (const status of slice.statuses) {
      if (await tx.statuses.findById(status.id)) {
        alreadyPresent += 1
        continue
      }
      await tx.statuses.create(status)
      copied.statuses += 1
    }

    for (const milestone of slice.milestones) {
      if (await tx.milestones.findById(milestone.id)) {
        alreadyPresent += 1
        continue
      }
      await tx.milestones.create(milestone)
      copied.milestones += 1
    }

    const movingIssueIds = new Set(slice.issues.map(issue => issue.id))
    for (const issue of slice.issues) {
      if (await tx.issues.findById(issue.id)) {
        alreadyPresent += 1
        continue
      }
      // A card whose parent is neither moving with it nor already on the target
      // would point at a row that is not there. The board's own rule is that a
      // parent which goes away leaves its children parentless, so that is what
      // happens here too — said out loud, because a person is losing a link.
      const parentIsReachable = issue.parentIssueId === null
        || movingIssueIds.has(issue.parentIssueId)
        || (await tx.issues.findById(issue.parentIssueId)) !== null
      if (!parentIsReachable) {
        warnings.push(`${issue.id} lost its parent card, which is not on this board`)
      }
      const { contextRefs, ...row } = issue
      await tx.issues.create({ ...row, parentIssueId: parentIsReachable ? issue.parentIssueId : null })
      copied.issues += 1
      if (contextRefs !== '[]') {
        await tx.contextRefs.replace(issue.id, contextRefs, issue.updatedAt)
        copied.contextRefs += 1
      }
    }

    for (const comment of slice.comments) {
      if (await tx.comments.findById(comment.id)) {
        alreadyPresent += 1
        continue
      }
      await tx.comments.create(comment)
      copied.comments += 1
    }

    for (const run of slice.runs) {
      if (await tx.runs.findById(run.id)) {
        alreadyPresent += 1
        continue
      }
      await tx.runs.create(run)
      copied.runs += 1
    }

    for (const relation of slice.relations) {
      if (await tx.relations.findById(relation.id)) {
        alreadyPresent += 1
        continue
      }
      await tx.relations.create(relation)
      copied.relations += 1
    }

    // Field changes carry no lookup by id of their own — they are read a card
    // at a time — so what the target already has is read a card at a time too.
    const changesByIssue = new Map<string, IssueFieldChange[]>()
    for (const change of slice.fieldChanges) {
      changesByIssue.set(change.issueId, [...(changesByIssue.get(change.issueId) ?? []), change])
    }
    for (const [issueId, changes] of changesByIssue) {
      const present = new Set((await tx.fieldChanges.listByIssue(issueId)).map(change => change.id))
      for (const change of changes) {
        if (present.has(change.id)) {
          alreadyPresent += 1
          continue
        }
        await tx.fieldChanges.create(change)
        copied.fieldChanges += 1
      }
    }

    // Pull request links, like field changes, are read a card at a time. One
    // the target holds under another id names the same pull request — `link`
    // hands back that standing row — so it is already present too.
    const linksByIssue = new Map<string, IssuePullRequest[]>()
    for (const link of slice.pullRequests) {
      linksByIssue.set(link.issueId, [...(linksByIssue.get(link.issueId) ?? []), link])
    }
    for (const [issueId, links] of linksByIssue) {
      const present = new Set((await tx.pullRequests.listByIssue(issueId)).map(link => link.id))
      for (const link of links) {
        if (present.has(link.id) || (await tx.pullRequests.link(link)).id !== link.id) {
          alreadyPresent += 1
          continue
        }
        copied.pullRequests += 1
      }
    }

    // One bump for the whole copy: a reader watching the target refetches once,
    // not once per card.
    await tx.meta.bumpRevision('board', currentUnixSeconds())
  })

  if (alreadyPresent > 0) {
    warnings.push(`${alreadyPresent} rows were already present on the target board and were left as they are`)
  }
  return { copied, warnings }
}

/**
 * Empty the slice off the board it was read from, in a transaction of its own.
 *
 * Only the cards, the columns and the milestones are named: comments, runs,
 * links, pull request links and the field-change history hang off a card by a
 * foreign key that cascades on both engines, so deleting the card takes them
 * with it.
 */
export async function deleteBoardSlice(from: BoardStore, slice: BoardSlice): Promise<void> {
  await from.transaction(async (tx) => {
    for (const issue of slice.issues) {
      await tx.issues.delete(issue.id)
    }
    for (const milestone of slice.milestones) {
      await tx.milestones.delete(milestone.id)
    }
    for (const status of slice.statuses) {
      await tx.statuses.delete(status.id)
    }
    await tx.meta.bumpRevision('board', currentUnixSeconds())
  })
}

/**
 * What a copy would collide with on the target, said before a row is written.
 *
 * The board carries two uniqueness rules that a *second* board of the same
 * workspace can break: a column's name within its workspace, and a card's
 * number within it. In practice it is the columns that collide: a standard set
 * created a second time carries the same names under new ids, while a card's id
 * is its key (`BST-001`), so two generations of card *number* 1 are two rows
 * with one id — which the copy treats as already present rather than as a
 * clash. The number check covers the case where they are not: a workspace whose
 * identifier changed between the two generations numbers from 1 again under
 * different ids.
 *
 * A row the target already has *by id* is not a collision — it is the
 * idempotent half of the copy, which is why the holder's id is compared rather
 * than merely counted. Milestones need no check: neither engine makes their
 * titles unique.
 */
async function assertTheCopyFits(tx: BoardStore, slice: BoardSlice, workspaceId: string): Promise<void> {
  const conflicts: { kind: 'card' | 'column', value: string | number, heldBy: string }[] = []

  const numbers = new Map((await tx.issues.listByWorkspace(workspaceId)).map(issue => [issue.number, issue.id]))
  for (const issue of slice.issues) {
    const holder = numbers.get(issue.number)
    if (holder !== undefined && holder !== issue.id) {
      conflicts.push({ kind: 'card', value: issue.number, heldBy: holder })
    }
  }

  const names = new Map((await tx.statuses.listByWorkspace(workspaceId)).map(status => [status.name, status.id]))
  for (const status of slice.statuses) {
    const holder = names.get(status.name)
    if (holder !== undefined && holder !== status.id) {
      conflicts.push({ kind: 'column', value: status.name, heldBy: holder })
    }
  }

  if (conflicts.length > 0) {
    throw new BoardError('board_copy_conflict', { workspaceId, conflicts })
  }
}

/**
 * The same cards, ordered so that a parent is always written before its
 * children. The column is a foreign key onto the same table, so any other order
 * writes a card pointing at one that is not there yet.
 */
function orderParentsFirst(issues: Issue[]): Issue[] {
  const byId = new Map(issues.map(issue => [issue.id, issue]))
  const ordered: Issue[] = []
  const placed = new Set<string>()

  function place(issue: Issue, ancestors: Set<string>): void {
    if (placed.has(issue.id) || ancestors.has(issue.id)) {
      return
    }
    ancestors.add(issue.id)
    const parent = issue.parentIssueId === null ? undefined : byId.get(issue.parentIssueId)
    if (parent) {
      place(parent, ancestors)
    }
    placed.add(issue.id)
    ordered.push(issue)
  }

  for (const issue of issues) {
    place(issue, new Set())
  }
  return ordered
}

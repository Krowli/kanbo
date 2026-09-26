import type { BoardStore } from '../board-store'

/**
 * What numbering needs to know about a workspace: enough to build the key stem,
 * and nothing else. A host app's workspace row satisfies it; so does a workspace
 * a command-line tool resolved from a path, without the board reading anybody's
 * tables to find it.
 *
 * Written out rather than `Pick`ed from a row type, because the board has no row
 * to pick from: a workspace belongs to whoever tracks it, and this package declares only what it
 * needs of one.
 */
export interface BoardWorkspaceIdentity {
  id: string
  identifier: string
  name: string
}

/** The three-letter stem every issue key in the workspace starts with. */
export function readIssuePrefix(workspace: BoardWorkspaceIdentity): string {
  const raw = workspace.identifier || workspace.name || workspace.id
  const normalized = raw.toUpperCase().replace(/[^A-Z0-9]/g, '')
  return (normalized.slice(0, 3) || 'ISS').padEnd(3, 'X')
}

export function formatIssueId(prefix: string, number: number): string {
  return `${prefix}-${number.toString().padStart(3, '0')}`
}

/**
 * The key and number the next issue of this workspace gets. The loop skips keys
 * an earlier prefix already took, so a renamed workspace never collides with its
 * own history.
 */
export async function nextIssueIdentity(workspace: BoardWorkspaceIdentity, store: BoardStore): Promise<{ id: string, number: number }> {
  const prefix = readIssuePrefix(workspace)
  let number = await store.issues.maxNumber(workspace.id) + 1

  while (true) {
    const id = formatIssueId(prefix, number)
    const existing = await store.issues.findById(id)
    if (!existing) {
      return { id, number }
    }
    number += 1
  }
}

// `tx` is the store the caller is working through: inside `store.transaction`
// that is the transactional view, so the read sees what the transaction has
// already written.
export async function nextIssueNumber(workspaceId: string, tx: BoardStore): Promise<number> {
  return await tx.issues.maxNumber(workspaceId) + 1
}

export async function nextIssueOrder(workspaceId: string, tx: BoardStore): Promise<number> {
  return await tx.issues.maxOrder(workspaceId) + 1024
}

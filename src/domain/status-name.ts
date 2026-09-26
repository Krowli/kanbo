/**
 * The columns a workspace gets the first time someone opens its board, in board
 * order. A workspace that already holds statuses is never re-seeded.
 */
export const DEFAULT_STATUSES = [
  { name: 'Backlog', description: 'Idea captured, not ready to work on', color: '#6b7280', category: 'backlog' as const },
  { name: 'To Do', description: 'Spelled out, ready to launch', color: '#9ca3af', category: 'unstarted' as const },
  { name: 'In Progress', description: 'The orchestrator and its agents are working', color: '#f59e0b', category: 'started' as const },
  { name: 'In Review', description: 'Work done; being checked or waiting for you', color: '#8b5cf6', category: 'started' as const },
  { name: 'Done', description: 'Accepted', color: '#22c55e', category: 'completed' as const },
  { name: 'Canceled', description: 'Canceled', color: '#6b7280', category: 'canceled' as const },
] as const

/**
 * The slug two status names have in common when they mean the same column:
 * case and the run of spaces or dashes between words are ignored, so `In
 * Progress`, `in-progress` and `IN_PROGRESS` all resolve to one status.
 */
export function normalizeStatusName(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_')
}

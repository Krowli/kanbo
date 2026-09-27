/**
 * The columns a workspace gets the first time someone opens its board, in board
 * order. A workspace that already holds statuses is never re-seeded.
 */
export const DEFAULT_STATUSES = [
  { name: 'Backlog', description: 'Ideas and requests, not ready to start', color: '#6b7280', category: 'backlog' as const },
  { name: 'To Do', description: 'Ready to start — agents take work from here', color: '#9ca3af', category: 'unstarted' as const },
  { name: 'In Progress', description: 'A person or an agent is working on it', color: '#f59e0b', category: 'started' as const },
  { name: 'In Review', description: 'Work done; being checked, or waiting for a person', color: '#8b5cf6', category: 'started' as const },
  { name: 'Done', description: 'Finished and accepted', color: '#22c55e', category: 'completed' as const },
  { name: 'Canceled', description: 'Won\'t be done', color: '#6b7280', category: 'canceled' as const },
] as const

/**
 * The slug two status names have in common when they mean the same column:
 * case and the run of spaces or dashes between words are ignored, so `In
 * Progress`, `in-progress` and `IN_PROGRESS` all resolve to one status.
 */
export function normalizeStatusName(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_')
}

import type { ServeCardView } from '../views'

export type Priority = ServeCardView['priority']

export interface CardFilters {
  text: string
  /** A key from `cardWorker`, `'nobody'`, or `null` for anyone. */
  worker: string | null
  waiting: boolean
  running: boolean
  priorities: Priority[]
  labels: string[]
}

export const NO_FILTERS: CardFilters = { text: '', worker: null, waiting: false, running: false, priorities: [], labels: [] }

/** Highest first, as the bar lists them. */
export const PRIORITIES: readonly Priority[] = ['urgent', 'high', 'medium', 'low', 'none']

/**
 * Who is working a card right now, for the "Worked by" filter and the card chip:
 * the agent of the running run, else the delegated agent, else the assignee.
 * `null` when nobody is.
 */
export function cardWorker(card: ServeCardView): { key: string, label: string } | null {
  if (card.activeRun?.state === 'running' && card.activeRun.agentName) {
    return { key: `agent:${card.activeRun.agentName}`, label: card.activeRun.agentName }
  }
  if (card.delegateAgentId) {
    return { key: `agent:${card.delegateAgentId}`, label: card.delegateAgentId }
  }
  if (card.assigneeKind === 'user') {
    return { key: 'user', label: 'You' }
  }
  if (card.assigneeKind === 'agent' && card.assigneeId) {
    return { key: `agent:${card.assigneeId}`, label: card.assigneeId }
  }
  return null
}

export function matchesFilters(card: ServeCardView, filters: CardFilters): boolean {
  const text = filters.text.trim().toLowerCase()
  if (text) {
    const haystack = [card.id, card.title, card.description, card.statusLine, ...card.labels]
    if (!haystack.some(part => part?.toLowerCase().includes(text))) {
      return false
    }
  }
  if (filters.worker !== null) {
    const worker = cardWorker(card)
    if (filters.worker === 'nobody' ? worker !== null : worker?.key !== filters.worker) {
      return false
    }
  }
  if (filters.waiting && card.waitingFor !== 'human') {
    return false
  }
  if (filters.running && card.activeRun?.state !== 'running') {
    return false
  }
  if (filters.priorities.length > 0 && !filters.priorities.includes(card.priority)) {
    return false
  }
  if (filters.labels.length > 0 && !card.labels.some(label => filters.labels.includes(label))) {
    return false
  }
  return true
}

export function filterOptions(cards: readonly ServeCardView[]): { workers: { key: string, label: string }[], labels: string[] } {
  const workers = new Map<string, string>()
  const labels = new Set<string>()
  for (const card of cards) {
    const worker = cardWorker(card)
    if (worker) {
      workers.set(worker.key, worker.label)
    }
    for (const label of card.labels) {
      labels.add(label)
    }
  }
  return {
    workers: [...workers].map(([key, label]) => ({ key, label })).sort((a, b) => a.label.localeCompare(b.label)),
    labels: [...labels].sort((a, b) => a.localeCompare(b)),
  }
}

export function isFiltering(filters: CardFilters): boolean {
  return filters.text.trim() !== '' || filters.worker !== null || filters.waiting || filters.running
    || filters.priorities.length > 0 || filters.labels.length > 0
}

function list(value: string | null): string[] {
  return value ? value.split(',').filter(part => part !== '') : []
}

export function readFilters(search: string): CardFilters {
  const params = new URLSearchParams(search)
  return {
    text: params.get('q') ?? '',
    worker: params.get('who') || null,
    waiting: params.get('waiting') === '1',
    running: params.get('running') === '1',
    priorities: list(params.get('priority')).filter((value): value is Priority => (PRIORITIES as readonly string[]).includes(value)),
    labels: list(params.get('label')),
  }
}

/** The query string with the filter params set (empty ones removed) and every other param — `project` — kept. */
export function writeFilters(filters: CardFilters, search: string): string {
  const params = new URLSearchParams(search)
  const set = (name: string, value: string | null): void => {
    if (value) {
      params.set(name, value)
    }
    else {
      params.delete(name)
    }
  }
  set('q', filters.text.trim() === '' ? null : filters.text)
  set('who', filters.worker)
  set('waiting', filters.waiting ? '1' : null)
  set('running', filters.running ? '1' : null)
  set('priority', filters.priorities.join(',') || null)
  set('label', filters.labels.join(',') || null)
  const written = params.toString()
  return written ? `?${written}` : ''
}

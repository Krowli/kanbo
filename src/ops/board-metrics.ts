import { cardDisplayTitle } from '../domain/card-display-title'
import { BoardError } from '../domain/errors'
import { readFlowRules } from '../domain/flow-rules'
import { isoWeekOf, utcDayLabel } from '../domain/iso-week'
import { normalizeStatusName } from '../domain/status-name'
import { utcDayStart } from '../domain/time'
import type { Issue, IssueComment, IssueMilestone, IssueRun, IssueStatus } from '../sqlite/schema'
import type { CardStretch } from './card-timeline'
import { buildCardTimeline, statusAt } from './card-timeline'
import type { ColumnEntry } from './column-entries'

const DAY_SECONDS = 86_400
const WEEK_SECONDS = 7 * DAY_SECONDS

/** What the metrics are asked about: the workspaces, the range (unix seconds, both ends included) and, for a sprint, its milestone. */
export interface BoardMetricsInput {
  workspaceIds: readonly string[]
  from: number
  to: number
  milestoneId?: string | null
}

/** Every row the metrics are computed from, as the store lists them — one board's, or several boards' put together. */
export interface BoardMetricsHistory {
  statuses: IssueStatus[]
  milestones: IssueMilestone[]
  cards: Issue[]
  /** Every column change of those cards, from the first on. */
  entries: ColumnEntry[]
  runs: IssueRun[]
  /** The approvals of those cards: `system.approved` comments. Returns are read from `entries` (R012-7). */
  approvals: IssueComment[]
}

/** A duration over the cards a metric counts, in seconds: nearest-rank percentiles, `null` over no cards. */
export interface BoardMetricsDurations {
  cards: number
  p50: number | null
  p85: number | null
}

/** A column as the metrics name it: one per slug across the workspaces, in the first workspace's board order. */
export interface BoardMetricsColumn {
  slug: string
  name: string
  category: IssueStatus['category']
}

export interface BoardMetricsWeek {
  /** ISO 8601 week, `2026-W02`. */
  week: string
  /** Monday 00:00 UTC of the week, unix seconds. */
  start: number
  finished: number
}

export interface BoardMetricsWip {
  slug: string
  cards: number
  /** The most cards the column may hold: the workspaces' limits added up when each has one, `null` for no limit. */
  limit: number | null
}

export interface BoardMetricsCard {
  issueId: string
  workspaceId: string
  title: string
}

export interface BoardMetricsAgingCard extends BoardMetricsCard {
  /** The column the card is in now. */
  slug: string
  startedAt: number
  ageSeconds: number
  inColumnSeconds: number
  /** Older than the range's cycle-time p85. */
  overCycleP85: boolean
}

export interface BoardMetricsFinishedCard extends BoardMetricsCard {
  /** `null` for a card that never entered a started column. */
  startedAt: number | null
  finishedAt: number
  cycleSeconds: number | null
  leadSeconds: number
  returns: number
  runs: number
}

export interface BoardMetricsColumnTime {
  slug: string
  seconds: number
}

export interface BoardMetricsFlowDay {
  /** The UTC day, `2026-01-05`. */
  day: string
  /** When the day is read: its last second, or the end of the range on its last day. */
  at: number
  /** Cards per column slug at `at`; every column is present. */
  cards: Record<string, number>
}

export interface BoardMetricsAgent {
  /** `agentId` when its runs carry one, else `agentName` (`boardMetricsAgentKey`). */
  key: string
  agentId: string | null
  /** The name its newest run was started under. */
  agentName: string
  /** Its runs started in the range. */
  runs: { total: number, finished: number, failed: number, stopped: number, running: number }
  /** Median length of those that ended (nearest rank), seconds; `null` when none ended. */
  medianRunSeconds: number | null
  /** Cards finished in the range that it ran at least once. */
  cardsFinished: number
  /** The share of those cards returned at least once; `null` when there are none. */
  returnRate: number | null
}

/**
 * Moves back over the cards finished in the range (R012-7): a move to an
 * earlier column of the same board whose category is unstarted or started, by
 * anyone.
 */
export interface BoardMetricsReturns {
  total: number
  perFinishedCard: number | null
  /** Finished cards with zero returns ÷ finished cards. */
  firstPassRate: number | null
  /** The same returns by who made them: a person, an agent (a provider target counts as one), or an outside writer (`system`). */
  byActorKind: { user: number, agent: number, external: number }
}

export interface BoardMetricsPerson {
  /** The person's actor id; `null` for one who gave none. */
  id: string | null
  created: number
  approvals: number
  returns: number
  /** Column changes they made; creating a card is not one. */
  moves: number
}

/**
 * How work flows on a board over a range (spec 2026-11-05, Part 4).
 *
 * Started is the first entry into a `started` column; finished is the latest
 * entry into a `completed` column, for a card still in one; cycle time is
 * finished − started and lead time finished − created, both as nearest-rank
 * p50 and p85. Cards in a `canceled` column are counted in `canceled` and left
 * out of everything else.
 */
export interface BoardMetrics {
  /** The range read; `to` is never later than `now`. */
  range: { from: number, to: number }
  now: number
  milestoneId: string | null
  columns: BoardMetricsColumn[]
  cycleTime: BoardMetricsDurations
  leadTime: BoardMetricsDurations
  /** Cards finished per ISO week, every week the range touches. */
  throughput: BoardMetricsWeek[]
  /** Cards in each `started` column now. */
  wip: BoardMetricsWip[]
  /** The cards in `started` columns now, oldest first. */
  aging: BoardMetricsAgingCard[]
  /** Seconds the cards finished in the range spent in each column before they finished. */
  timeInColumn: BoardMetricsColumnTime[]
  /** Cards per column at the end of each UTC day of the range. */
  cumulativeFlow: BoardMetricsFlowDay[]
  /** The cards finished in the range, in the order they finished. */
  finished: BoardMetricsFinishedCard[]
  returns: BoardMetricsReturns
  attempts: { runs: number, perFinishedCard: number | null }
  canceled: number
  agents: BoardMetricsAgent[]
  people: BoardMetricsPerson[]
}

/**
 * The value at `percent` of `values` by nearest rank (ruling R012-2): the
 * ⌈percent·n/100⌉-th in ascending order. Always a value that occurred; `null`
 * for none.
 */
export function nearestRank(values: readonly number[], percent: number): number | null {
  if (values.length === 0) {
    return null
  }
  const sorted = values.toSorted((left, right) => left - right)
  return sorted[Math.max(Math.ceil((percent * sorted.length) / 100), 1) - 1]!
}

/** Who a run counts under in the agent rows: the host's agent id when the run names one, else the name it was started under. */
export function boardMetricsAgentKey(run: Pick<IssueRun, 'agentId' | 'agentName'>): string {
  return run.agentId ?? run.agentName
}

interface CardFacts {
  card: Issue
  stretches: CardStretch[]
  startedAt: number | null
}

/** The cards the metrics count — the workspaces', the milestone's when one is asked — split by whether they sit in a canceled column now. */
interface MetricsScope {
  statusById: Map<string, IssueStatus>
  counted: Issue[]
  canceled: Issue[]
}

function scopeOf(history: BoardMetricsHistory, input: BoardMetricsInput): MetricsScope {
  const workspaceIds = new Set(input.workspaceIds)
  const milestoneId = input.milestoneId ?? null
  const statusById = new Map(history.statuses.filter(status => workspaceIds.has(status.workspaceId)).map(status => [status.id, status]))
  const cards = history.cards
    .filter(card => workspaceIds.has(card.workspaceId))
    .filter(card => milestoneId === null || card.milestoneId === milestoneId)
  const isCanceled = (card: Issue) => card.statusId !== null && statusById.get(card.statusId)?.category === 'canceled'
  return { statusById, counted: cards.filter(card => !isCanceled(card)), canceled: cards.filter(isCanceled) }
}

/**
 * The runs of the counted cards, and apart those of the cards in a canceled
 * column (R012-6): what a host prices to put a cost beside the metrics, and the
 * spend on canceled work on a line of its own.
 */
export function boardMetricsRuns(history: BoardMetricsHistory, input: BoardMetricsInput): { counted: IssueRun[], canceled: IssueRun[] } {
  const { counted, canceled } = scopeOf(history, input)
  const countedIds = new Set(counted.map(card => card.id))
  const canceledIds = new Set(canceled.map(card => card.id))
  return {
    counted: history.runs.filter(run => countedIds.has(run.issueId)),
    canceled: history.runs.filter(run => canceledIds.has(run.issueId)),
  }
}

/** Who made a return, as `returns.byActorKind` counts it: a person, an agent (a provider target stands in for one), or a writer from outside. */
function returnerOf(entry: ColumnEntry): keyof BoardMetricsReturns['byActorKind'] {
  if (entry.actorKind === 'user') {
    return 'user'
  }
  return entry.actorKind === 'system' ? 'external' : 'agent'
}

/**
 * The metrics of `input` over rows already read. Pure: the same rows give the
 * same answer in any order, so a host may put several boards' rows together
 * and compute once — percentiles of parts do not add up to the whole's.
 */
export function computeBoardMetrics(history: BoardMetricsHistory, input: BoardMetricsInput, now: number): BoardMetrics {
  if (input.from > input.to) {
    throw new BoardError('board_metrics_range_invalid', { from: input.from, to: input.to })
  }
  const milestoneId = input.milestoneId ?? null
  if (milestoneId !== null && !history.milestones.some(milestone => milestone.id === milestoneId && input.workspaceIds.includes(milestone.workspaceId))) {
    throw new BoardError('issue_milestone_not_found', { milestoneId })
  }
  const from = input.from
  const to = Math.min(input.to, now)
  const inRange = (at: number) => from <= at && at <= to

  const { statusById, counted, canceled } = scopeOf(history, input)
  const columns = groupColumns(input.workspaceIds, [...statusById.values()])
  const slugOf = (statusId: string | null) => {
    const status = statusId === null ? undefined : statusById.get(statusId)
    return status ? normalizeStatusName(status.name) : null
  }
  const categoryOf = (statusId: string | null) => (statusId === null ? null : statusById.get(statusId)?.category ?? null)
  // A return is a move back to an earlier column of the same board that is unstarted or started, by anyone (R012-7).
  const isReturn = (entry: ColumnEntry) => {
    const source = entry.fromStatusId === null ? undefined : statusById.get(entry.fromStatusId)
    const target = statusById.get(entry.toStatusId)
    return source !== undefined && target !== undefined
      && source.workspaceId === target.workspaceId
      && target.order < source.order
      && (target.category === 'unstarted' || target.category === 'started')
  }
  const entriesByCard = groupBy(history.entries, entry => entry.issueId)
  const timelineOf = (card: Issue) => buildCardTimeline(card, entriesByCard.get(card.id) ?? [])
  const countedIds = new Set(counted.map(card => card.id))

  const facts = counted.map((card): CardFacts => {
    const stretches = timelineOf(card)
    return { card, stretches, startedAt: stretches.find(stretch => categoryOf(stretch.statusId) === 'started')?.from ?? null }
  })
  const finished = facts
    .filter(fact => categoryOf(fact.card.statusId) === 'completed')
    // Finished is the latest entry into a completed column: the move that began the stretch the card is in now.
    .map(fact => ({ ...fact, finishedAt: fact.stretches.at(-1)!.from }))
    .filter(fact => inRange(fact.finishedAt))
    .toSorted((left, right) => left.finishedAt - right.finishedAt || left.card.id.localeCompare(right.card.id))
  const runsByCard = groupBy(history.runs.filter(run => countedIds.has(run.issueId)), run => run.issueId)
  const returnsByCard = groupBy(history.entries.filter(entry => countedIds.has(entry.issueId) && isReturn(entry)), entry => entry.issueId)
  const finishedCards = finished.map((fact): BoardMetricsFinishedCard => ({
    ...cardOf(fact.card),
    startedAt: fact.startedAt,
    finishedAt: fact.finishedAt,
    cycleSeconds: fact.startedAt === null ? null : fact.finishedAt - fact.startedAt,
    leadSeconds: fact.finishedAt - fact.card.createdAt,
    returns: returnsByCard.get(fact.card.id)?.length ?? 0,
    runs: runsByCard.get(fact.card.id)?.length ?? 0,
  }))
  const cycleTime = durations(finishedCards.flatMap(card => (card.cycleSeconds === null ? [] : [card.cycleSeconds])))
  const leadTime = durations(finishedCards.map(card => card.leadSeconds))

  const throughput: BoardMetricsWeek[] = []
  for (let start = isoWeekOf(from).start; from <= to && start <= to; start += WEEK_SECONDS) {
    throughput.push({
      week: isoWeekOf(start).week,
      start,
      finished: finishedCards.filter(card => card.finishedAt >= start && card.finishedAt < start + WEEK_SECONDS).length,
    })
  }

  const inProgress = facts.filter(fact => categoryOf(fact.card.statusId) === 'started')
  const wip = columns
    .filter(column => column.category === 'started')
    .map((column): BoardMetricsWip => {
      const limits = [...statusById.values()]
        .filter(status => normalizeStatusName(status.name) === column.slug)
        .map(status => readFlowRules(status).wipLimit)
      return {
        slug: column.slug,
        cards: inProgress.filter(fact => slugOf(fact.card.statusId) === column.slug).length,
        limit: limits.every(limit => limit !== null) ? limits.reduce<number>((sum, limit) => sum + limit!, 0) : null,
      }
    })
  const aging = inProgress
    .map((fact): BoardMetricsAgingCard => {
      const current = fact.stretches.at(-1)!
      // A card in a started column has entered one: at the latest, the stretch it is in now.
      const startedAt = fact.startedAt ?? current.from
      return {
        ...cardOf(fact.card),
        slug: slugOf(fact.card.statusId)!,
        startedAt,
        ageSeconds: now - startedAt,
        inColumnSeconds: now - current.from,
        overCycleP85: cycleTime.p85 !== null && now - startedAt > cycleTime.p85,
      }
    })
    .toSorted((left, right) => right.ageSeconds - left.ageSeconds || left.issueId.localeCompare(right.issueId))

  const columnSeconds = new Map(columns.map(column => [column.slug, 0]))
  for (const fact of finished) {
    for (const stretch of fact.stretches) {
      const slug = slugOf(stretch.statusId)
      const end = Math.min(stretch.to ?? fact.finishedAt, fact.finishedAt)
      if (slug !== null && end > stretch.from) {
        columnSeconds.set(slug, (columnSeconds.get(slug) ?? 0) + end - stretch.from)
      }
    }
  }

  const cumulativeFlow: BoardMetricsFlowDay[] = []
  for (let dayStart = utcDayStart(from); from <= to && dayStart <= to; dayStart += DAY_SECONDS) {
    const at = Math.min(dayStart + DAY_SECONDS - 1, to)
    const cards = Object.fromEntries(columns.map(column => [column.slug, 0]))
    for (const fact of facts) {
      const statusId = statusAt(fact.stretches, at)
      const slug = statusId === undefined ? null : slugOf(statusId)
      if (slug !== null) {
        cards[slug] = (cards[slug] ?? 0) + 1
      }
    }
    cumulativeFlow.push({ day: utcDayLabel(dayStart), at, cards })
  }

  const finishedReturns = finished.flatMap(fact => returnsByCard.get(fact.card.id) ?? [])
  const byActorKind = { user: 0, agent: 0, external: 0 }
  for (const entry of finishedReturns) {
    byActorKind[returnerOf(entry)]++
  }
  const runTotal = finishedCards.reduce((sum, card) => sum + card.runs, 0)
  const share = (part: number, whole: number) => (whole === 0 ? null : part / whole)
  return {
    range: { from, to },
    now,
    milestoneId,
    columns,
    cycleTime,
    leadTime,
    throughput,
    wip,
    aging,
    timeInColumn: columns.map(column => ({ slug: column.slug, seconds: columnSeconds.get(column.slug) ?? 0 })),
    cumulativeFlow,
    finished: finishedCards,
    returns: {
      total: finishedReturns.length,
      perFinishedCard: share(finishedReturns.length, finishedCards.length),
      firstPassRate: share(finishedCards.filter(card => card.returns === 0).length, finishedCards.length),
      byActorKind,
    },
    attempts: { runs: runTotal, perFinishedCard: share(runTotal, finishedCards.length) },
    // Counted apart (ruling R012-6): canceled in the range is the latest entry into a canceled column, inside it.
    canceled: canceled.filter(card => inRange(timelineOf(card).at(-1)!.from)).length,
    agents: agentRows(history.runs.filter(run => countedIds.has(run.issueId)), finishedCards, inRange),
    people: personRows(counted, history, countedIds, inRange, isReturn),
  }
}

function agentRows(runs: IssueRun[], finished: BoardMetricsFinishedCard[], inRange: (at: number) => boolean): BoardMetricsAgent[] {
  const finishedIds = new Set(finished.map(card => card.issueId))
  const returned = new Set(finished.filter(card => card.returns > 0).map(card => card.issueId))
  const rows: BoardMetricsAgent[] = []
  for (const [key, own] of groupBy(runs, boardMetricsAgentKey)) {
    const ranged = own.filter(run => inRange(run.startedAt))
    const worked = new Set(own.map(run => run.issueId).filter(issueId => finishedIds.has(issueId)))
    if (ranged.length === 0 && worked.size === 0) {
      continue
    }
    const newest = own.toSorted((left, right) => right.startedAt - left.startedAt || right.id.localeCompare(left.id))[0]!
    const ended = ranged.flatMap(run => (run.endedAt === null ? [] : [run.endedAt - run.startedAt]))
    rows.push({
      key,
      agentId: newest.agentId,
      agentName: newest.agentName,
      runs: {
        total: ranged.length,
        finished: ranged.filter(run => run.state === 'finished').length,
        failed: ranged.filter(run => run.state === 'failed').length,
        stopped: ranged.filter(run => run.state === 'stopped').length,
        running: ranged.filter(run => run.state === 'running').length,
      },
      medianRunSeconds: nearestRank(ended, 50),
      cardsFinished: worked.size,
      returnRate: worked.size === 0 ? null : [...worked].filter(issueId => returned.has(issueId)).length / worked.size,
    })
  }
  return rows.toSorted((left, right) => right.runs.total - left.runs.total || left.key.localeCompare(right.key))
}

function personRows(
  counted: Issue[],
  history: BoardMetricsHistory,
  countedIds: Set<string>,
  inRange: (at: number) => boolean,
  isReturn: (entry: ColumnEntry) => boolean,
): BoardMetricsPerson[] {
  const rows = new Map<string | null, BoardMetricsPerson>()
  const row = (id: string | null) => {
    let found = rows.get(id)
    if (!found) {
      found = { id, created: 0, approvals: 0, returns: 0, moves: 0 }
      rows.set(id, found)
    }
    return found
  }
  for (const card of counted) {
    if (card.createdByKind === 'user' && inRange(card.createdAt)) {
      row(card.createdById).created++
    }
  }
  // Only approvals: a person's Return is counted through its move below (R012-7).
  for (const comment of history.approvals) {
    if (comment.authorKind === 'system.approved' && countedIds.has(comment.issueId) && inRange(comment.createdAt)) {
      row(comment.authorId).approvals++
    }
  }
  for (const entry of history.entries) {
    // A creation (`null → column`, since 0.5.0) is the card's first column, not a move (R012-4).
    if (entry.actorKind === 'user' && entry.fromStatusId !== null && countedIds.has(entry.issueId) && inRange(entry.at)) {
      const person = row(entry.actorId)
      person.moves++
      if (isReturn(entry)) {
        person.returns++
      }
    }
  }
  const activity = (person: BoardMetricsPerson) => person.created + person.approvals + person.returns + person.moves
  return [...rows.values()].toSorted((left, right) =>
    activity(right) - activity(left) || (left.id ?? '\uFFFF').localeCompare(right.id ?? '\uFFFF'))
}

/**
 * The workspaces' columns as one board shows them, one per slug (ruling
 * R012-8): the first workspace's columns set the order, and a column only a
 * later one has goes right after the column before it there. Name and category
 * are the first workspace's that has it.
 */
function groupColumns(workspaceIds: readonly string[], statuses: IssueStatus[]): BoardMetricsColumn[] {
  const columns: BoardMetricsColumn[] = []
  for (const workspaceId of new Set(workspaceIds)) {
    let previous = -1
    const own = statuses
      .filter(status => status.workspaceId === workspaceId)
      .toSorted((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    for (const status of own) {
      const slug = normalizeStatusName(status.name)
      let index = columns.findIndex(column => column.slug === slug)
      if (index === -1) {
        index = previous + 1
        columns.splice(index, 0, { slug, name: status.name, category: status.category })
      }
      previous = index
    }
  }
  return columns
}

function durations(values: number[]): BoardMetricsDurations {
  return { cards: values.length, p50: nearestRank(values, 50), p85: nearestRank(values, 85) }
}

function cardOf(card: Issue): BoardMetricsCard {
  return { issueId: card.id, workspaceId: card.workspaceId, title: cardDisplayTitle(card) }
}

function groupBy<T, K>(items: readonly T[], keyOf: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>()
  for (const item of items) {
    const key = keyOf(item)
    groups.set(key, [...(groups.get(key) ?? []), item])
  }
  return groups
}

import type { BoardMetrics, BoardMetricsAgent, BoardMetricsPerson } from '../ops/board-metrics'
import type { BoardSprint } from '../ops/sprints'
import { sanitizeTerminalText } from './terminal-text'

/** Every field `kanbo stats --json` may name, in the order the value carries them. */
export const BOARD_METRICS_FIELDS: readonly (keyof BoardMetrics)[] = [
  'range',
  'now',
  'milestoneId',
  'columns',
  'cycleTime',
  'leadTime',
  'throughput',
  'wip',
  'aging',
  'timeInColumn',
  'cumulativeFlow',
  'finished',
  'returns',
  'attempts',
  'canceled',
  'agents',
  'people',
]

const LABEL_WIDTH = 16

/** A duration as the command line prints it: minutes under an hour, hours under a day, then days, to one decimal; a dash for none. */
export function formatDuration(seconds: number | null): string {
  if (seconds === null) {
    return '—'
  }
  if (seconds < 3_600) {
    return `${Math.round(seconds / 60)}m`
  }
  if (seconds < 86_400) {
    return `${Number((seconds / 3_600).toFixed(1))}h`
  }
  return `${Number((seconds / 86_400).toFixed(1))}d`
}

function percent(share: number | null): string {
  return share === null ? '—' : `${Math.round(share * 100)}%`
}

function decimal(value: number | null): string {
  return value === null ? '—' : String(Number(value.toFixed(1)))
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

function day(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10)
}

/** A labelled block: the first item beside the label, the rest under it; a dash when there is nothing. */
function block(label: string, items: readonly string[]): string[] {
  const [first = '—', ...rest] = items
  return [`${label.padEnd(LABEL_WIDTH)}${first}`, ...rest.map(item => `${' '.repeat(LABEL_WIDTH)}${item}`)]
}

/** Items joined on one line, or none at all. */
function oneLine(items: readonly string[]): string[] {
  return items.length === 0 ? [] : [items.join(' · ')]
}

/**
 * The metrics as a person reads them in a terminal: the range, then one block
 * per figure. The cumulative flow is a series per day and has no one-screen
 * form, so the last line says how to get it.
 */
export function describeMetrics(metrics: BoardMetrics, sprint: BoardSprint | null): string {
  const column = (slug: string) => sanitizeTerminalText(metrics.columns.find(candidate => candidate.slug === slug)?.name ?? slug)
  const by = metrics.returns.byActorKind
  const lines = [`${day(metrics.range.from)} → ${day(metrics.range.to)}`]
  if (sprint) {
    lines.push(`${sanitizeTerminalText(sprint.title)}: ${sprint.cards.open + sprint.cards.done} planned · ${sprint.cards.done} done`)
  }
  if (metrics.range.from > metrics.range.to) {
    return [...lines, 'Nothing measured yet: the range starts after now.'].join('\n')
  }
  lines.push(
    ...block('Cycle time', [`p50 ${formatDuration(metrics.cycleTime.p50)} · p85 ${formatDuration(metrics.cycleTime.p85)} (${count(metrics.cycleTime.cards, 'card')})`]),
    ...block('Lead time', [`p50 ${formatDuration(metrics.leadTime.p50)} · p85 ${formatDuration(metrics.leadTime.p85)}`]),
    ...block('Throughput', oneLine(metrics.throughput.map(week => `${week.week} ${week.finished}`))),
    ...block('In progress', oneLine(metrics.wip.map(wip => `${column(wip.slug)} ${wip.cards}${wip.limit === null ? '' : `/${wip.limit}`}`))),
    ...block('First pass', [`${percent(metrics.returns.firstPassRate)} · attempts ${decimal(metrics.attempts.perFinishedCard)} per card`]),
    ...block('Returns', [`${metrics.returns.total} (people ${by.user} · agents ${by.agent} · outside ${by.external}) · ${decimal(metrics.returns.perFinishedCard)} per card`]),
    ...block('Canceled', [String(metrics.canceled)]),
    ...block('Aging', metrics.aging.map(card => `${card.issueId} ${column(card.slug)} ${formatDuration(card.ageSeconds)}${card.overCycleP85 ? ' (older than p85)' : ''}`)),
    ...block('Time in column', oneLine(metrics.timeInColumn.filter(time => time.seconds > 0).map(time => `${column(time.slug)} ${formatDuration(time.seconds)}`))),
    ...block('Agents', metrics.agents.map(describeAgent)),
    ...block('People', metrics.people.map(describePerson)),
    'Cumulative flow by day: kanbo stats --json cumulativeFlow',
  )
  return lines.join('\n')
}

function describeAgent(agent: BoardMetricsAgent): string {
  const { runs } = agent
  return `${sanitizeTerminalText(agent.agentName)}: ${count(runs.total, 'run')} (${runs.finished} finished · ${runs.failed} failed · ${runs.stopped} stopped · ${runs.running} running)`
    + ` · median ${formatDuration(agent.medianRunSeconds)} · ${count(agent.cardsFinished, 'card')} finished · ${percent(agent.returnRate)} returned`
}

function describePerson(person: BoardMetricsPerson): string {
  return `${sanitizeTerminalText(person.id ?? 'unnamed')}: ${person.created} created · ${person.approvals} approved · ${person.returns} returned · ${person.moves} moved`
}

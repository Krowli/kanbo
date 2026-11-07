import type { BoardMetrics } from '../../ops/board-metrics'
import type { BoardSprint } from '../../ops/sprints'
import { isoWeekOf } from '../../domain/iso-week'
import type { BoardApi, MetricsQuery } from './api'
import {
  dataTable,
  flowPaletteIndex,
  renderFlow,
  renderTimeBars,
  renderWeekBars,
} from './charts'
import { button, el } from './dom'

/**
 * The Analytics view: how work flows on this board, from the numbers
 * `kanbo stats` prints (`GET /issues/metrics`). Pickers, figure cards, three
 * hand-drawn charts, the aging cards, an agents table and a people table, in
 * the order Modular's Analytics has them (minus cost, which is Modular's own).
 *
 * `createAnalyticsData` is the part that fetches — only while the view is open,
 * and once more per new board version — and `renderAnalytics` draws what it
 * holds.
 */

export const RANGES = [4, 12, 26] as const
export type RangeWeeks = typeof RANGES[number]

export interface AnalyticsQuery {
  weeks: RangeWeeks
  /** A sprint's id; it replaces the weeks. */
  sprint: string | null
}

const WEEK_SECONDS = 7 * 86_400

/**
 * What to ask the route for. Twelve weeks and no sprint is its own default, so
 * nothing is sent; four or twenty-six weeks start on the Monday that makes the
 * range that many ISO weeks long, the current one included, as `kanbo stats`
 * counts them.
 */
export function metricsQueryFor(query: AnalyticsQuery, now: number): MetricsQuery {
  if (query.sprint !== null) {
    return { sprint: query.sprint }
  }
  return query.weeks === 12 ? {} : { from: isoWeekOf(now).start - (query.weeks - 1) * WEEK_SECONDS }
}

// ---- formatting ----

/** "5h" under a day, else "2.6d" (a whole number of days without its ".0"); "—" for none. Under an hour, minutes. */
export function formatDuration(seconds: number | null): string {
  if (seconds === null) {
    return '—'
  }
  if (seconds < 3600) {
    return `${Math.max(0, Math.round(seconds / 60))}m`
  }
  if (seconds < 86_400) {
    return `${Math.round(seconds / 3600)}h`
  }
  return `${trimZero((seconds / 86_400).toFixed(1))}d`
}

function trimZero(text: string): string {
  return text.replace(/\.0$/, '')
}

/** "1.3 a week": the cards finished over the weeks the range touches. */
export function formatThroughput(finished: number, weeks: number): string {
  return `${trimZero((weeks > 0 ? finished / weeks : 0).toFixed(1))} a week`
}

/** "40%", or "—" for none. */
export function formatPercent(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`
}

/** The page names its own person "You", as the board does elsewhere; everyone else by the id they wrote under. */
export function personLabel(id: string | null): string {
  if (id === null) {
    return 'Unknown'
  }
  return id === '__self__' ? 'You' : id
}

// ---- data ----

export interface AnalyticsState {
  metrics: BoardMetrics | null
  sprints: BoardSprint[]
  /** A fetch is going. The last data stays on screen meanwhile. */
  loading: boolean
  error: string | null
  query: AnalyticsQuery
}

export interface AnalyticsData {
  state: () => AnalyticsState
  /** The view opened, or its range or sprint changed. */
  show: (query: AnalyticsQuery) => void
  /** The board changed while the view is open: read the numbers again. */
  boardChanged: () => void
  /** Read again, as after a failure. */
  retry: () => void
  /** Another view is on screen: no more fetches. */
  hide: () => void
  /** Forget everything, as when another project is shown. */
  reset: () => void
}

/**
 * Fetches the metrics, and nothing else, while the view is open: never from a
 * hidden view, and once per `boardChanged`. An answer that arrives after a
 * newer question was asked is dropped.
 */
export function createAnalyticsData(
  api: Pick<BoardApi, 'metrics' | 'sprints'>,
  workspaceId: () => string | null,
  onChange: () => void,
): AnalyticsData {
  let state: AnalyticsState = { metrics: null, sprints: [], loading: false, error: null, query: { weeks: 12, sprint: null } }
  let open = false
  let generation = 0

  const set = (next: Partial<AnalyticsState>): void => {
    state = { ...state, ...next }
    onChange()
  }

  async function load(withSprints: boolean): Promise<void> {
    const mine = ++generation
    set({ loading: true, error: null })
    try {
      const id = workspaceId()
      const [metrics, sprints] = await Promise.all([
        api.metrics(metricsQueryFor(state.query, Math.floor(Date.now() / 1000))),
        withSprints && id !== null ? api.sprints(id) : Promise.resolve(state.sprints),
      ])
      if (mine === generation && open) {
        set({ metrics, sprints, loading: false })
      }
    }
    catch (error) {
      if (mine === generation && open) {
        set({ loading: false, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  return {
    state: () => state,
    show: (query) => {
      const changed = state.query.weeks !== query.weeks || state.query.sprint !== query.sprint
      const wasOpen = open
      state = { ...state, query }
      open = true
      if (wasOpen && !changed && (state.metrics !== null || state.loading)) {
        return
      }
      // The sprints are read when the view opens, and the first time they are missing.
      void load(!wasOpen || state.sprints.length === 0)
    },
    boardChanged: () => {
      if (open) {
        void load(true)
      }
    },
    retry: () => {
      if (open) {
        void load(true)
      }
    },
    hide: () => {
      open = false
      generation += 1
      if (state.loading) {
        state = { ...state, loading: false }
      }
    },
    reset: () => {
      open = false
      generation += 1
      state = { metrics: null, sprints: [], loading: false, error: null, query: state.query }
    },
  }
}

// ---- the view ----

export interface AnalyticsActions {
  onQuery: (query: AnalyticsQuery) => void
  onRetry: () => void
  onOpenCard: (cardId: string) => void
}

export interface AnalyticsView {
  element: HTMLElement
  /** Stop watching the panels' size; called when the view is built again or left. */
  dispose: () => void
}

const DEFINITIONS = {
  cycle: 'From the first time a card enters a started column to the moment it is finished. p50 is the median; p85 is the time 85% of the cards beat.',
  throughput: 'Cards finished per week over this range.',
  wip: 'Cards in started columns right now, against each column\'s limit.',
  firstPass: 'Finished cards that were never sent back to an earlier column.',
  planned: 'The cards of this sprint, and how many of them are finished.',
}

function figure(label: string, definition: string, value: string, ...details: string[]): HTMLElement {
  const card = el('div', 'figure')
  const name = el('abbr', 'figure-label', label)
  name.title = definition
  card.append(name, el('div', 'figure-value', value), ...details.map(detail => el('div', 'figure-detail', detail)))
  return card
}

function columnName(metrics: BoardMetrics, slug: string): string {
  return metrics.columns.find(column => column.slug === slug)?.name ?? slug
}

function weeksIn(metrics: BoardMetrics): number {
  return metrics.throughput.length
}

/** "In Progress 1/2 · In Review 1": the started columns' cards, against the limit where there is one. */
export function describeWip(metrics: BoardMetrics): string {
  const parts = metrics.wip.map(wip => `${columnName(metrics, wip.slug)} ${wip.cards}${wip.limit === null ? '' : `/${wip.limit}`}`)
  return parts.length === 0 ? 'No started columns' : parts.join(' · ')
}

function figures(metrics: BoardMetrics, sprint: BoardSprint | null): HTMLElement {
  const grid = el('div', 'figures')
  const finished = metrics.finished.length
  const inProgress = metrics.wip.reduce((sum, wip) => sum + wip.cards, 0)
  const by = metrics.returns.byActorKind
  grid.append(
    figure('Cycle time', DEFINITIONS.cycle,
      metrics.cycleTime.p50 === null ? '—' : `p50 ${formatDuration(metrics.cycleTime.p50)} · p85 ${formatDuration(metrics.cycleTime.p85)}`,
      `Lead time p50 ${formatDuration(metrics.leadTime.p50)} · p85 ${formatDuration(metrics.leadTime.p85)}`),
    figure('Throughput', DEFINITIONS.throughput, formatThroughput(finished, weeksIn(metrics)), `${finished} finished`),
    figure('In progress now', DEFINITIONS.wip, String(inProgress), describeWip(metrics)),
    figure('First-pass approval', DEFINITIONS.firstPass, formatPercent(metrics.returns.firstPassRate),
      `Returns: ${metrics.returns.total} (people ${by.user} · agents ${by.agent} · outside ${by.external})`),
  )
  if (sprint) {
    const planned = sprint.cards.open + sprint.cards.done
    grid.append(figure('Planned vs done', DEFINITIONS.planned, `${sprint.cards.done} of ${planned}`, planned === 0 ? 'No cards' : `${Math.round((sprint.cards.done / planned) * 100)}% done`))
  }
  return grid
}

/** Skeleton blocks in the shape of the figures and panels, while the first answer is on its way. */
function skeleton(): HTMLElement {
  const wrap = el('div', 'analytics-skeleton')
  wrap.setAttribute('aria-busy', 'true')
  wrap.setAttribute('aria-label', 'Loading analytics')
  const figuresRow = el('div', 'figures')
  for (let index = 0; index < 4; index++) {
    figuresRow.append(el('div', 'figure skeleton'))
  }
  const panels = el('div', 'panels')
  for (let index = 0; index < 4; index++) {
    panels.append(el('div', 'panel-card skeleton skeleton-panel'))
  }
  wrap.append(figuresRow, panels)
  return wrap
}

function pickers(state: AnalyticsState, actions: AnalyticsActions): HTMLElement {
  const row = el('div', 'analytics-pickers')
  const segmented = el('div', 'segmented')
  segmented.setAttribute('role', 'group')
  segmented.setAttribute('aria-label', 'Range')
  for (const weeks of RANGES) {
    const pressed = state.query.sprint === null && state.query.weeks === weeks
    const choice = button(`Last ${weeks} weeks`, '', () => actions.onQuery({ weeks, sprint: null }))
    choice.setAttribute('aria-pressed', String(pressed))
    segmented.append(choice)
  }
  const wrap = el('label', 'select-wrap sprint-select')
  wrap.append(el('span', 'visually-hidden', 'Sprint'))
  const select = el('select', 'field')
  const none = el('option', undefined, 'No sprint')
  none.value = ''
  select.append(none)
  for (const sprint of state.sprints) {
    const option = el('option', undefined, sprint.title)
    option.value = sprint.id
    select.append(option)
  }
  select.value = state.query.sprint ?? ''
  select.addEventListener('change', () => actions.onQuery({ weeks: state.query.weeks, sprint: select.value === '' ? null : select.value }))
  wrap.append(select)
  row.append(segmented, wrap)
  return row
}

interface ChartPanel {
  element: HTMLElement
  /** Draw the chart again at the panel's width. */
  redraw: () => void
}

/** A panel with a title and a help line; its chart is drawn at the panel's width and again when that changes. */
function chartPanel(title: string, help: string, draw: (width: number) => SVGSVGElement, table: HTMLTableElement, legend?: HTMLElement): ChartPanel {
  const element = el('section', 'panel-card')
  const heading = el('h3', 'chart-title', title)
  const body = el('div', 'chart-body')
  let width = 0
  const render = (): void => {
    // Before the panel is in the page it has no width: draw at a width that will do.
    const measured = Math.floor(body.clientWidth)
    width = measured > 0 ? measured : width || 560
    body.replaceChildren(draw(width))
  }
  render()
  element.append(heading, el('p', 'panel-help', help), ...(legend ? [legend] : []), body, table)
  return {
    element,
    redraw: () => {
      const measured = Math.floor(body.clientWidth)
      if (measured > 0 && measured !== width) {
        render()
      }
    },
  }
}

function legend(items: { name: string, index: number }[]): HTMLElement {
  const list = el('ul', 'chart-legend')
  for (const item of items) {
    const entry = el('li')
    entry.append(el('span', `legend-swatch chart-series-${item.index}`), item.name)
    list.append(entry)
  }
  return list
}

function agingPanel(metrics: BoardMetrics, actions: AnalyticsActions): HTMLElement {
  const panel = el('section', 'panel-card')
  panel.append(el('h3', 'chart-title', 'Aging work'), el('p', 'panel-help', 'Cards in started columns, oldest first. Marked when older than this range\'s cycle-time p85.'))
  if (metrics.aging.length === 0) {
    panel.append(el('p', 'panel-empty', 'No card is in a started column.'))
    return panel
  }
  const list = el('ul', 'aging-list')
  for (const card of metrics.aging) {
    const item = el('li')
    const row = el('button', 'aging-row')
    row.type = 'button'
    row.dataset.cardId = card.issueId
    const age = el('span', 'aging-age', formatDuration(card.ageSeconds))
    age.toggleAttribute('data-over', card.overCycleP85)
    if (card.overCycleP85) {
      age.title = 'Older than this range\'s cycle-time p85'
    }
    row.append(
      el('span', 'card-key', card.issueId),
      el('span', 'aging-title', card.title),
      el('span', 'aging-where', `${formatDuration(card.inColumnSeconds)} in ${columnName(metrics, card.slug)}`),
      age,
    )
    row.addEventListener('click', () => actions.onOpenCard(card.issueId))
    item.append(row)
    list.append(item)
  }
  panel.append(list)
  return panel
}

function tablePanel(title: string, head: string[], rows: (HTMLElement | string)[][], empty: string): HTMLElement {
  const panel = el('section', 'panel-card panel-table')
  panel.append(el('h3', 'chart-title', title))
  if (rows.length === 0) {
    panel.append(el('p', 'panel-empty', empty))
    return panel
  }
  const table = el('table', 'data-table')
  const header = el('tr')
  header.append(...head.map(cell => el('th', undefined, cell)))
  const thead = el('thead')
  thead.append(header)
  const body = el('tbody')
  for (const row of rows) {
    const line = el('tr')
    for (const cell of row) {
      const td = el('td')
      td.append(cell)
      line.append(td)
    }
    body.append(line)
  }
  table.append(thead, body)
  panel.append(table)
  return panel
}

function agentsPanel(metrics: BoardMetrics): HTMLElement {
  const rows = metrics.agents.map((agent) => {
    const runs = el('span')
    const parts = [`${agent.runs.finished} finished`, `${agent.runs.failed} failed`, `${agent.runs.stopped} stopped`, ...(agent.runs.running > 0 ? [`${agent.runs.running} running`] : [])]
    runs.append(el('strong', 'runs-total', String(agent.runs.total)), ' ', el('small', 'runs-detail', parts.join(' · ')))
    return [agent.agentName, runs, formatDuration(agent.medianRunSeconds), String(agent.cardsFinished), formatPercent(agent.returnRate)]
  })
  return tablePanel('Agents', ['Agent', 'Runs', 'Median run', 'Cards finished', 'Returned'], rows, 'No agent has run on this board in this range.')
}

function peoplePanel(metrics: BoardMetrics): HTMLElement {
  const rows = metrics.people.map(person => [personLabel(person.id), String(person.created), String(person.approvals), String(person.returns), String(person.moves)])
  return tablePanel('People', ['Person', 'Created', 'Approved', 'Returned', 'Moves'], rows, 'Nobody has written to this board in this range.')
}

/** The three charts, or a line saying nothing finished; the aging panel is theirs to keep either way. */
function charts(metrics: BoardMetrics, panels: ChartPanel[]): HTMLElement[] {
  if (metrics.finished.length === 0) {
    const empty = el('section', 'panel-card analytics-empty')
    empty.append(el('h3', 'chart-title', 'Nothing finished in this range yet'), el('p', 'panel-help', 'Finished per week, cumulative flow and time in column fill in once a card reaches a finished column.'))
    return [empty]
  }
  const order = metrics.columns.map(column => column.slug)
  const formatDays = (days: number): string => formatDuration(days * 86_400)

  const weeks = chartPanel('Finished per week', 'Cards finished in each ISO week.', width => renderWeekBars(metrics.throughput, width),
    dataTable('Cards finished per week', ['Week', 'Finished'], metrics.throughput.map(week => [week.week, week.finished])))

  const flowLegend = legend([...metrics.columns].reverse().map(column => ({ name: column.name, index: flowPaletteIndex(order, column.slug) })))
  const flow = chartPanel('Cumulative flow', 'Cards in each column at the end of each day, rebuilt from the moves.', width => renderFlow(metrics.cumulativeFlow, metrics.columns, width),
    dataTable('Cards per column at the end of each day', ['Day', ...metrics.columns.map(column => column.name)], metrics.cumulativeFlow.map(day => [day.day, ...metrics.columns.map(column => day.cards[column.slug] ?? 0)])),
    flowLegend)

  const time = chartPanel('Time in column', 'Time the cards finished in this range spent in each column before they finished: where cards wait.', width => renderTimeBars(metrics.timeInColumn, metrics.columns, width, formatDays),
    dataTable('Days spent in each column', ['Column', 'Days'], metrics.timeInColumn.map(entry => [columnName(metrics, entry.slug), formatDuration(entry.seconds)])))

  panels.push(weeks, flow, time)
  return [weeks.element, flow.element, time.element]
}

/** Build the whole view from what the data holds. */
export function renderAnalytics(state: AnalyticsState, actions: AnalyticsActions): AnalyticsView {
  const root = el('div', 'analytics')
  root.dataset.loading = String(state.loading)
  const panels: ChartPanel[] = []
  let observer: ResizeObserver | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  root.append(pickers(state, actions))

  if (state.error !== null && state.metrics === null) {
    const failure = el('div', 'analytics-error')
    failure.setAttribute('role', 'alert')
    failure.append(el('p', undefined, state.error), button('Try again', 'secondary', actions.onRetry))
    root.append(failure)
  }
  else if (state.metrics === null) {
    root.append(skeleton())
  }
  else {
    const metrics = state.metrics
    if (state.error !== null) {
      const failure = el('div', 'analytics-error')
      failure.setAttribute('role', 'alert')
      failure.append(el('p', undefined, `${state.error} The numbers below are the last that loaded.`), button('Try again', 'secondary', actions.onRetry))
      root.append(failure)
    }
    const sprint = state.query.sprint === null ? null : state.sprints.find(candidate => candidate.id === state.query.sprint) ?? null
    root.append(figures(metrics, sprint))
    const grid = el('div', 'panels')
    const drawn = charts(metrics, panels)
    // Two panels a row from 900 px: finished per week and cumulative flow, then time in column and the aging cards.
    grid.append(...drawn, agingPanel(metrics, actions))
    root.append(grid, agentsPanel(metrics), peoplePanel(metrics))
    root.append(el('p', 'analytics-note', `Canceled in this range: ${metrics.canceled}. Canceled cards are left out of every other number.`))
  }

  if (panels.length > 0 && typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(() => {
      // Throttled: a drag of the window resizes many times a second.
      if (timer === null) {
        timer = setTimeout(() => {
          timer = null
          for (const panel of panels) {
            panel.redraw()
          }
        }, 120)
      }
    })
    observer.observe(root)
  }

  return {
    element: root,
    dispose: () => {
      observer?.disconnect()
      if (timer !== null) {
        clearTimeout(timer)
      }
    },
  }
}

import type { BoardMetricsColumn, BoardMetricsColumnTime, BoardMetricsFlowDay, BoardMetricsWeek } from '../../ops/board-metrics'
import { el } from './dom'

/**
 * The Analytics charts, drawn by hand as SVG: no chart library. The first half
 * of this file is geometry — plain numbers in, plain numbers out, tested with
 * no DOM — and the second builds the SVG from it with `createElementNS`.
 *
 * Colour never comes from an attribute or a `style`: every shape carries a
 * class (`chart-series-0` …) and the stylesheet paints it from the chart
 * palette tokens. Each bar, area and point has an SVG `<title>`, which is its
 * tooltip.
 */

export const CHART_HEIGHT = 220
/** How many colours the palette has; a series past it starts the palette again. */
export const PALETTE_SIZE = 8

export interface PlotBox {
  width: number
  height: number
  left: number
  right: number
  top: number
  bottom: number
}

/** The area inside the axes: room at the left for the y labels and at the bottom for the x labels. */
export function plotBox(width: number, height = CHART_HEIGHT, margins: Partial<Pick<PlotBox, 'left' | 'right' | 'top' | 'bottom'>> = {}): PlotBox {
  const left = margins.left ?? 32
  const right = width - (margins.right ?? 12)
  const top = margins.top ?? 8
  const bottom = height - (margins.bottom ?? 24)
  return { width, height, left, right, top, bottom }
}

/** Whole-number ticks from 0 up to at least `max`, about `target` of them: 0, 1, 2 … for a small max, 0, 5, 10 … for a large one. */
export function integerTicks(max: number, target = 4): number[] {
  const top = Math.max(1, Math.ceil(max))
  const step = Math.max(1, Math.ceil(top / target))
  const ticks: number[] = []
  for (let tick = 0; tick < top + step; tick += step) {
    ticks.push(tick)
    if (tick >= top) {
      break
    }
  }
  return ticks
}

/** Ticks for a value that is not a count (days): "nice" steps of 1, 2, 5 × a power of ten, from 0 to at least `max`. */
export function niceTicks(max: number, target = 6): number[] {
  if (!(max > 0)) {
    return [0, 1]
  }
  const rough = max / target
  const power = 10 ** Math.floor(Math.log10(rough))
  const step = [1, 2, 5, 10].map(multiple => multiple * power).find(candidate => candidate >= rough) ?? power * 10
  const ticks: number[] = []
  for (let tick = 0; tick < max + step; tick += step) {
    ticks.push(Number(tick.toFixed(10)))
    if (tick >= max) {
      break
    }
  }
  return ticks
}

/** A straight scale: `domain` onto `range`. A domain of no width maps everything to the start of the range. */
export function scaleLinear(domain: readonly [number, number], range: readonly [number, number]): (value: number) => number {
  const span = domain[1] - domain[0]
  return value => (span === 0 ? range[0] : range[0] + ((value - domain[0]) / span) * (range[1] - range[0]))
}

export interface BarShape {
  x: number
  y: number
  width: number
  height: number
  value: number
  label: string
}

/**
 * Vertical bars, one per value, each in an equal band of the plot, as wide as
 * `fill` of its band (at most `maxWidth`), standing on the bottom edge. `yMax`
 * is the value at the top edge.
 */
export function barGeometry(values: readonly number[], labels: readonly string[], box: PlotBox, yMax: number, fill = 0.5, maxWidth = 36): BarShape[] {
  const band = (box.right - box.left) / Math.max(values.length, 1)
  const y = scaleLinear([0, yMax], [box.bottom, box.top])
  return values.map((value, index) => {
    const width = Math.min(band * fill, maxWidth)
    const top = y(value)
    return { x: box.left + band * index + (band - width) / 2, y: top, width, height: box.bottom - top, value, label: labels[index] ?? '' }
  })
}

export interface StackLayer {
  slug: string
  /** Per day: the layer's lower and upper edge in cards, the layers below it counted. */
  points: { lower: number, upper: number }[]
}

/**
 * Stack the columns of each day, the last column at the bottom, so that the
 * top of the highest layer is the day's total. `order` is the board's column
 * order; the first layer returned is the bottom one.
 */
export function stackLayers(days: readonly BoardMetricsFlowDay[], order: readonly string[]): StackLayer[] {
  const bottomUp = [...order].reverse()
  const running = days.map(() => 0)
  return bottomUp.map(slug => ({
    slug,
    points: days.map((day, index) => {
      const lower = running[index]!
      const upper = lower + (day.cards[slug] ?? 0)
      running[index] = upper
      return { lower, upper }
    }),
  }))
}

/** The most cards any day holds, the sum of its columns. */
export function flowMax(days: readonly BoardMetricsFlowDay[]): number {
  return days.reduce((most, day) => Math.max(most, Object.values(day.cards).reduce((sum, count) => sum + count, 0)), 0)
}

/** The outline of one layer as an SVG path: along its upper edge, back along its lower. `x(i)` and `y(cards)` are the scales. */
export function areaPath(points: StackLayer['points'], x: (index: number) => number, y: (cards: number) => number): string {
  if (points.length === 0) {
    return ''
  }
  const upper = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${round(x(index))} ${round(y(point.upper))}`)
  const lower = points.map((point, index) => `L${round(x(index))} ${round(y(point.lower))}`).reverse()
  return `${upper.join(' ')} ${lower.join(' ')} Z`
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

/** Which of `count` labels to draw so that no more than `max` are: evenly spaced, the first always among them. */
export function thinIndices(count: number, max: number): number[] {
  if (count <= 0 || max <= 0) {
    return []
  }
  const step = Math.ceil(count / max)
  return Array.from({ length: Math.ceil(count / step) }, (_, index) => index * step)
}

export interface HorizontalBar {
  y: number
  width: number
  height: number
  value: number
  label: string
}

/** One bar a row, each `rowHeight` tall, from the left edge to `value` on a scale that ends at `xMax` on the right edge. */
export function horizontalBarGeometry(values: readonly number[], labels: readonly string[], box: PlotBox, xMax: number, rowHeight: number, fill = 0.55): HorizontalBar[] {
  const x = scaleLinear([0, xMax], [box.left, box.right])
  return values.map((value, index) => {
    const height = rowHeight * fill
    return { y: box.top + rowHeight * index + (rowHeight - height) / 2, width: x(value) - box.left, height, value, label: labels[index] ?? '' }
  })
}

/** How tall the time-in-column chart is: 32 px a column, and at least 120. */
export function timeChartHeight(columns: number): number {
  return Math.max(120, columns * 32 + 32)
}

// ---- drawing ----

const SVG_NS = 'http://www.w3.org/2000/svg'

type Attributes = Record<string, string | number>

function node<K extends keyof SVGElementTagNameMap>(tag: K, className?: string, attributes: Attributes = {}, ...children: (SVGElement | string)[]): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, tag)
  if (className) {
    element.setAttribute('class', className)
  }
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, String(value))
  }
  for (const child of children) {
    element.append(child)
  }
  return element
}

/** A tooltip: an SVG `<title>` as the shape's first child. */
function tip(text: string): SVGTitleElement {
  const title = node('title')
  title.textContent = text
  return title
}

function surface(width: number, height: number, label: string): SVGSVGElement {
  const svg = node('svg', 'chart', { viewBox: `0 0 ${width} ${height}`, width, height, role: 'img', 'aria-label': label, focusable: 'false' })
  return svg
}

function axisLabel(text: string, x: number, y: number, anchor: 'start' | 'middle' | 'end'): SVGTextElement {
  return node('text', 'chart-axis', { x: round(x), y: round(y), 'text-anchor': anchor }, text)
}

/** Dashed horizontal gridlines and the y labels for `ticks`, on a scale from `y`. */
function horizontalGrid(svg: SVGSVGElement, box: PlotBox, ticks: readonly number[], y: (value: number) => number, format: (tick: number) => string = String): void {
  for (const tick of ticks) {
    svg.append(
      node('line', 'chart-grid', { x1: box.left, x2: box.right, y1: round(y(tick)), y2: round(y(tick)) }),
      axisLabel(format(tick), box.left - 6, y(tick) + 3, 'end'),
    )
  }
}

/** Cards finished per ISO week: vertical bars with integer ticks and dashed gridlines. */
export function renderWeekBars(weeks: readonly BoardMetricsWeek[], width: number): SVGSVGElement {
  const total = weeks.reduce((sum, week) => sum + week.finished, 0)
  const svg = surface(width, CHART_HEIGHT, `Cards finished per week: ${total} in ${weeks.length} weeks`)
  const box = plotBox(width)
  const ticks = integerTicks(Math.max(0, ...weeks.map(week => week.finished)))
  const yMax = ticks.at(-1) ?? 1
  const y = scaleLinear([0, yMax], [box.bottom, box.top])
  horizontalGrid(svg, box, ticks, y)
  const bars = barGeometry(weeks.map(week => week.finished), weeks.map(week => week.week), box, yMax)
  // Labels are thinned to fit: about one per 64 px.
  const shown = new Set(thinIndices(weeks.length, Math.max(1, Math.floor((box.right - box.left) / 64))))
  bars.forEach((bar, index) => {
    svg.append(node('rect', 'chart-bar', { x: round(bar.x), y: round(bar.y), width: round(bar.width), height: round(bar.height), rx: 2 }, tip(`${bar.label}: ${bar.value} finished`)))
    if (shown.has(index)) {
      svg.append(axisLabel(bar.label, bar.x + bar.width / 2, box.bottom + 14, 'middle'))
    }
  })
  return svg
}

/** Cards per column at the end of each day: stacked areas, the last column at the bottom, with `MM-DD` labels. */
export function renderFlow(days: readonly BoardMetricsFlowDay[], columns: readonly BoardMetricsColumn[], width: number): SVGSVGElement {
  const order = columns.map(column => column.slug)
  const names = new Map(columns.map(column => [column.slug, column.name]))
  const last = days.at(-1)
  const svg = surface(width, CHART_HEIGHT, `Cumulative flow over ${days.length} days: ${last ? Object.values(last.cards).reduce((sum, count) => sum + count, 0) : 0} cards on the last day`)
  const box = plotBox(width)
  const ticks = integerTicks(flowMax(days))
  const yMax = ticks.at(-1) ?? 1
  const y = scaleLinear([0, yMax], [box.bottom, box.top])
  horizontalGrid(svg, box, ticks, y)
  // A single day is drawn as a band across the plot, so it is not invisible.
  const points = days.length === 1 ? [days[0]!, days[0]!] : days
  const x = scaleLinear([0, Math.max(points.length - 1, 1)], [box.left, box.right])
  const layers = stackLayers(points, order)
  layers.forEach((layer, index) => {
    const palette = flowPaletteIndex(order, layer.slug)
    const peak = Math.max(0, ...days.map(day => day.cards[layer.slug] ?? 0))
    svg.append(node('path', `chart-area chart-series-${palette}`, { d: areaPath(layer.points, x, y), 'data-layer': index },
      tip(`${names.get(layer.slug) ?? layer.slug}: up to ${peak} cards`)))
  })
  const shown = thinIndices(days.length, Math.max(1, Math.floor((box.right - box.left) / 48)))
  for (const index of shown) {
    const day = days[index]!
    svg.append(axisLabel(day.day.slice(5), x(days.length === 1 ? 0 : index), box.bottom + 14, index === 0 ? 'start' : 'middle'))
  }
  return svg
}

/** The palette colour of a column: its place in the board's order, so a column keeps its colour in the chart and the legend. */
export function flowPaletteIndex(order: readonly string[], slug: string): number {
  return Math.max(0, order.indexOf(slug)) % PALETTE_SIZE
}

/** Days the finished cards spent in each column: horizontal bars, 32 px a row. */
export function renderTimeBars(times: readonly BoardMetricsColumnTime[], columns: readonly BoardMetricsColumn[], width: number, formatDays: (days: number) => string): SVGSVGElement {
  const names = new Map(columns.map(column => [column.slug, column.name]))
  const height = timeChartHeight(times.length)
  const days = times.map(time => time.seconds / 86_400)
  const labels = times.map(time => names.get(time.slug) ?? time.slug)
  const svg = surface(width, height, `Time in column, in days: ${labels.map((label, index) => `${label} ${formatDays(days[index]!)}`).join(', ')}`)
  // Room on the left for the column names.
  const box = plotBox(width, height, { left: 88, top: 4, bottom: 28 })
  const ticks = niceTicks(Math.max(0, ...days))
  const xMax = ticks.at(-1) ?? 1
  const x = scaleLinear([0, xMax], [box.left, box.right])
  for (const tick of ticks) {
    svg.append(
      node('line', 'chart-grid', { x1: round(x(tick)), x2: round(x(tick)), y1: box.top, y2: box.bottom }),
      axisLabel(String(tick), x(tick), box.bottom + 14, 'middle'),
    )
  }
  const rowHeight = (box.bottom - box.top) / Math.max(times.length, 1)
  horizontalBarGeometry(days, labels, box, xMax, rowHeight).forEach((bar) => {
    svg.append(
      axisLabel(bar.label, box.left - 8, bar.y + bar.height / 2 + 3, 'end'),
      node('rect', 'chart-time-bar', { x: box.left, y: round(bar.y), width: round(Math.max(bar.width, 0)), height: round(bar.height), rx: 3 }, tip(`${bar.label}: ${formatDays(bar.value)}`)),
    )
  })
  return svg
}

/** The numbers behind a chart as a table only a screen reader sees. */
export function dataTable(caption: string, head: readonly string[], rows: readonly (readonly (string | number)[])[]): HTMLTableElement {
  const table = el('table', 'visually-hidden')
  table.append(el('caption', undefined, caption))
  const header = el('tr')
  header.append(...head.map(cell => el('th', undefined, cell)))
  const thead = el('thead')
  thead.append(header)
  const tbody = el('tbody')
  for (const row of rows) {
    const line = el('tr')
    line.append(...row.map(cell => el('td', undefined, String(cell))))
    tbody.append(line)
  }
  table.append(thead, tbody)
  return table
}

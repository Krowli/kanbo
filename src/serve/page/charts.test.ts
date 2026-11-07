// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'

import type { BoardMetricsColumn, BoardMetricsFlowDay, BoardMetricsWeek } from '../../ops/board-metrics'
import {
  areaPath,
  barGeometry,
  dataTable,
  flowMax,
  flowPaletteIndex,
  horizontalBarGeometry,
  integerTicks,
  niceTicks,
  plotBox,
  renderFlow,
  renderTimeBars,
  renderWeekBars,
  scaleLinear,
  stackLayers,
  thinIndices,
  timeChartHeight,
} from './charts'

const columns: BoardMetricsColumn[] = [
  { slug: 'backlog', name: 'Backlog', category: 'backlog' },
  { slug: 'todo', name: 'To Do', category: 'unstarted' },
  { slug: 'doing', name: 'In Progress', category: 'started' },
  { slug: 'done', name: 'Done', category: 'completed' },
]
const day = (label: string, cards: Partial<Record<string, number>>): BoardMetricsFlowDay => ({
  day: label,
  at: 0,
  cards: { backlog: 0, todo: 0, doing: 0, done: 0, ...cards },
})
const weeks: BoardMetricsWeek[] = [
  { week: '2026-W01', start: 0, finished: 1 },
  { week: '2026-W02', start: 0, finished: 3 },
  { week: '2026-W03', start: 0, finished: 0 },
]

describe('scaleLinear', () => {
  it('maps the domain onto the range, upside down when the range runs that way', () => {
    const y = scaleLinear([0, 10], [100, 0])
    expect(y(0)).toBe(100)
    expect(y(10)).toBe(0)
    expect(y(2.5)).toBe(75)
  })

  it('sends everything to the start of the range for a domain of no width', () => {
    expect(scaleLinear([3, 3], [20, 80])(3)).toBe(20)
  })
})

describe('integerTicks', () => {
  it('counts up in whole numbers from 0 to at least the max', () => {
    expect(integerTicks(0)).toEqual([0, 1])
    expect(integerTicks(2)).toEqual([0, 1, 2])
    expect(integerTicks(3)).toEqual([0, 1, 2, 3])
    expect(integerTicks(8)).toEqual([0, 2, 4, 6, 8])
    expect(integerTicks(9)).toEqual([0, 3, 6, 9])
    expect(integerTicks(21)).toEqual([0, 6, 12, 18, 24])
  })

  it('has only integers, always reaching the max', () => {
    for (const max of [1, 4, 5, 7, 13, 100]) {
      const ticks = integerTicks(max)
      expect(ticks.every(Number.isInteger)).toBe(true)
      expect(ticks.at(-1)!).toBeGreaterThanOrEqual(max)
    }
  })
})

describe('niceTicks', () => {
  it('steps by 1, 2, 5 or 10 times a power of ten', () => {
    expect(niceTicks(11.7)).toEqual([0, 2, 4, 6, 8, 10, 12])
    expect(niceTicks(0.8)).toEqual([0, 0.2, 0.4, 0.6, 0.8])
    expect(niceTicks(0)).toEqual([0, 1])
  })
})

describe('barGeometry', () => {
  const box = plotBox(400, 220)

  it('stands each bar on the bottom edge with a height in proportion to its value', () => {
    const bars = barGeometry([1, 2, 0], ['a', 'b', 'c'], box, 2)
    const plotHeight = box.bottom - box.top
    expect(bars.map(bar => bar.height)).toEqual([plotHeight / 2, plotHeight, 0])
    expect(bars.every(bar => bar.y + bar.height === box.bottom)).toBe(true)
  })

  it('gives every bar its own band, in order, inside the plot', () => {
    const bars = barGeometry([1, 1, 1], ['a', 'b', 'c'], box, 1)
    expect(bars.map(bar => bar.label)).toEqual(['a', 'b', 'c'])
    expect(bars[0]!.x).toBeGreaterThanOrEqual(box.left)
    expect(bars[1]!.x).toBeGreaterThan(bars[0]!.x + bars[0]!.width)
    expect(bars[2]!.x + bars[2]!.width).toBeLessThanOrEqual(box.right)
  })

  it('does not draw a bar wider than the cap', () => {
    expect(barGeometry([1], ['a'], box, 1, 0.9, 36)[0]!.width).toBe(36)
  })
})

describe('stackLayers', () => {
  const days = [day('2026-01-05', { backlog: 1, todo: 2, doing: 1 }), day('2026-01-06', { todo: 1, doing: 2, done: 3 })]
  const order = columns.map(column => column.slug)

  it('puts the last column at the bottom', () => {
    expect(stackLayers(days, order).map(layer => layer.slug)).toEqual(['done', 'doing', 'todo', 'backlog'])
  })

  it('stacks so that the top of the highest layer is the day\'s total, and layers touch', () => {
    const layers = stackLayers(days, order)
    const top = layers.at(-1)!
    expect(top.points.map(point => point.upper)).toEqual([4, 6])
    expect(flowMax(days)).toBe(6)
    layers.slice(1).forEach((layer, index) => {
      expect(layer.points.map(point => point.lower)).toEqual(layers[index]!.points.map(point => point.upper))
    })
    expect(layers[0]!.points[0]!.lower).toBe(0)
  })

  it('gives an empty column a layer of no thickness', () => {
    const doneLayer = stackLayers(days, order)[0]!
    expect(doneLayer.points[0]).toEqual({ lower: 0, upper: 0 })
    expect(doneLayer.points[1]).toEqual({ lower: 0, upper: 3 })
  })
})

describe('areaPath', () => {
  it('runs along the upper edge and back along the lower, and closes', () => {
    const path = areaPath([{ lower: 0, upper: 2 }, { lower: 1, upper: 3 }], index => index * 10, cards => 100 - cards * 10)
    expect(path).toBe('M0 80 L10 70 L10 90 L0 100 Z')
    expect(areaPath([], index => index, cards => cards)).toBe('')
  })
})

describe('thinIndices', () => {
  it('keeps every label when they fit, and spaces them evenly when they do not', () => {
    expect(thinIndices(4, 10)).toEqual([0, 1, 2, 3])
    expect(thinIndices(10, 5)).toEqual([0, 2, 4, 6, 8])
    expect(thinIndices(84, 12)).toHaveLength(12)
    expect(thinIndices(0, 5)).toEqual([])
  })
})

describe('horizontalBarGeometry', () => {
  it('draws a bar a row, as long as its value on the scale', () => {
    const box = plotBox(300, 120, { left: 88 })
    const bars = horizontalBarGeometry([2, 4], ['a', 'b'], box, 4, 30)
    expect(bars[1]!.width).toBeCloseTo(box.right - box.left)
    expect(bars[0]!.width).toBeCloseTo((box.right - box.left) / 2)
    expect(bars[1]!.y - bars[0]!.y).toBe(30)
  })

  it('makes the chart 32 px a column and at least 120 tall', () => {
    expect(timeChartHeight(2)).toBe(120)
    expect(timeChartHeight(6)).toBeGreaterThanOrEqual(6 * 32)
  })
})

describe('flowPaletteIndex', () => {
  it('gives a column the colour of its place in the board', () => {
    const order = columns.map(column => column.slug)
    expect(order.map(slug => flowPaletteIndex(order, slug))).toEqual([0, 1, 2, 3])
    expect(flowPaletteIndex(order, 'unknown')).toBe(0)
  })
})

describe('the drawn charts', () => {
  it('draws a bar per week with a tooltip, integer y labels and an accessible name', () => {
    const svg = renderWeekBars(weeks, 600)
    expect(svg.getAttribute('role')).toBe('img')
    expect(svg.getAttribute('aria-label')).toBe('Cards finished per week: 4 in 3 weeks')
    expect(svg.querySelectorAll('rect.chart-bar')).toHaveLength(3)
    expect([...svg.querySelectorAll('rect.chart-bar title')].map(title => title.textContent)).toEqual(['2026-W01: 1 finished', '2026-W02: 3 finished', '2026-W03: 0 finished'])
    expect([...svg.querySelectorAll('text.chart-axis')].map(text => text.textContent)).toContain('2026-W02')
    expect(svg.querySelectorAll('line.chart-grid').length).toBeGreaterThan(1)
    expect(svg.hasAttribute('style')).toBe(false)
  })

  it('draws an area per column with a class for its colour, and an MM-DD label', () => {
    const days = [day('2026-01-05', { todo: 2 }), day('2026-01-06', { todo: 1, done: 1 }), day('2026-01-07', { done: 2 })]
    const svg = renderFlow(days, columns, 600)
    expect(svg.querySelectorAll('path.chart-area')).toHaveLength(4)
    expect(svg.querySelector('path.chart-series-1 title')?.textContent).toBe('To Do: up to 2 cards')
    expect(svg.querySelector('path.chart-series-3 title')?.textContent).toBe('Done: up to 2 cards')
    expect([...svg.querySelectorAll('text.chart-axis')].map(text => text.textContent)).toContain('01-05')
    expect(svg.querySelector('*[style]')).toBeNull()
  })

  it('draws one day as a band instead of nothing', () => {
    const svg = renderFlow([day('2026-01-05', { todo: 2 })], columns, 600)
    expect(svg.querySelector('path.chart-series-1')?.getAttribute('d')).toMatch(/^M/)
  })

  it('draws a bar per column in days with the column names beside them', () => {
    const svg = renderTimeBars([{ slug: 'todo', seconds: 2 * 86_400 }, { slug: 'doing', seconds: 4 * 86_400 }], columns, 600, days => `${days}d`)
    expect([...svg.querySelectorAll('rect.chart-time-bar title')].map(title => title.textContent)).toEqual(['To Do: 2d', 'In Progress: 4d'])
    expect([...svg.querySelectorAll('text.chart-axis')].map(text => text.textContent)).toEqual(expect.arrayContaining(['To Do', 'In Progress']))
    expect(Number(svg.getAttribute('height'))).toBeGreaterThanOrEqual(120)
  })

  it('makes the numbers behind a chart available as a hidden table', () => {
    const table = dataTable('Finished per week', ['Week', 'Finished'], [['2026-W01', 1]])
    expect(table.className).toBe('visually-hidden')
    expect(table.querySelector('caption')?.textContent).toBe('Finished per week')
    expect([...table.querySelectorAll('td')].map(cell => cell.textContent)).toEqual(['2026-W01', '1'])
  })
})

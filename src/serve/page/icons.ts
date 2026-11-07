import type { ServeCardView, ServeStatusView } from '../views'

/**
 * The page's icons, drawn by hand as inline SVG — no font, no image file. Each
 * is built with `createElementNS`, takes its colour from `currentColor` (the
 * stylesheet sets it from the category or priority), and is hidden from screen
 * readers: the words beside it carry the meaning.
 */

const SVG_NS = 'http://www.w3.org/2000/svg'

type Category = ServeStatusView['category']
type Priority = ServeCardView['priority']

function node<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, tag)
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, String(value))
  }
  return element
}

function icon(className: string, ...parts: SVGElement[]): SVGSVGElement {
  const svg = node('svg', { viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none', 'aria-hidden': 'true', focusable: 'false' })
  svg.setAttribute('class', `icon ${className}`)
  svg.append(...parts)
  return svg
}

/** The ring every status-category icon starts from: a circle of radius 6 in a 16-unit box. */
function ring(width: number, extra: Record<string, string | number> = {}): SVGCircleElement {
  return node('circle', { cx: 8, cy: 8, r: 6, stroke: 'currentColor', 'stroke-width': width, ...extra })
}

/**
 * A status category: triage a heavy ring, backlog a dashed one, unstarted a
 * ring, started a ring half filled, completed a filled disc, canceled a ring
 * struck through.
 */
export function statusIcon(category: Category | null): SVGSVGElement {
  const kind = category ?? 'unstarted'
  const svg = icon('status-icon')
  svg.dataset.category = kind
  switch (kind) {
    case 'triage':
      svg.append(ring(2))
      break
    case 'backlog':
      svg.append(ring(1.5, { 'stroke-dasharray': '2 2.2' }))
      break
    case 'started':
      svg.append(ring(1.5), node('path', { d: 'M8 4.5a3.5 3.5 0 0 1 0 7z', fill: 'currentColor' }))
      break
    case 'completed':
      svg.append(node('circle', { cx: 8, cy: 8, r: 6.75, fill: 'currentColor' }))
      break
    case 'canceled':
      svg.append(ring(1.5), node('path', { d: 'M5.5 8h5', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round' }))
      break
    default:
      svg.append(ring(1.5))
  }
  return svg
}

/** How many bars a priority draws; none is a single line instead. */
export const PRIORITY_BARS: Record<Priority, number> = { none: 0, low: 1, medium: 2, high: 3, urgent: 4 }

/** Bars two wide with 1.5 gaps, 4, 6, 8 and 10 high, their bottoms on y=12. */
export function priorityIcon(priority: Priority): SVGSVGElement {
  const svg = icon('priority-icon')
  svg.dataset.priority = priority
  const bars = PRIORITY_BARS[priority]
  if (bars === 0) {
    svg.append(node('path', { d: 'M3 8h10', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round' }))
    return svg
  }
  for (let index = 0; index < bars; index++) {
    const height = 4 + 2 * index
    svg.append(node('rect', { x: 1.75 + index * 3.5, y: 12 - height, width: 2, height, rx: 0.5, fill: 'currentColor' }))
  }
  return svg
}

/** A clock, for "Waiting for you". */
export function clockIcon(): SVGSVGElement {
  return icon('clock-icon',
    node('circle', { cx: 8, cy: 8, r: 6, stroke: 'currentColor', 'stroke-width': 1.5 }),
    node('path', { d: 'M8 4.75V8l2 1.25', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }))
}

/** An arrow turning up and to the left: the sub-task's way back to its parent. */
export function parentIcon(): SVGSVGElement {
  return icon('parent-icon',
    node('path', { d: 'M12 12.5v-3a2 2 0 0 0-2-2H4.5m0 0L7 5m-2.5 2.5L7 10', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }))
}

/** A padlock, for a column with entry rules. */
export function lockIcon(): SVGSVGElement {
  return icon('lock-icon',
    node('rect', { x: 3.5, y: 7, width: 9, height: 6.5, rx: 1.5, stroke: 'currentColor', 'stroke-width': 1.5 }),
    node('path', { d: 'M5.5 7V5.5a2.5 2.5 0 0 1 5 0V7', stroke: 'currentColor', 'stroke-width': 1.5 }))
}

/** A chevron pointing down; a collapsed group rotates it by CSS. */
export function chevronIcon(): SVGSVGElement {
  return icon('chevron-icon',
    node('path', { d: 'M4.5 6.5 8 10l3.5-3.5', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }))
}

/** A check mark, inside a selected box. */
export function checkIcon(): SVGSVGElement {
  return icon('check-icon',
    node('path', { d: 'm3.5 8.5 3 3 6-6.5', stroke: 'currentColor', 'stroke-width': 1.75, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }))
}

export function plusIcon(): SVGSVGElement {
  return icon('plus-icon',
    node('path', { d: 'M8 3.5v9M3.5 8h9', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round' }))
}

export function closeIcon(): SVGSVGElement {
  return icon('close-icon',
    node('path', { d: 'm4 4 8 8M12 4l-8 8', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round' }))
}

export function searchIcon(): SVGSVGElement {
  return icon('search-icon',
    node('circle', { cx: 7, cy: 7, r: 4.25, stroke: 'currentColor', 'stroke-width': 1.5 }),
    node('path', { d: 'm10.25 10.25 3 3', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round' }))
}

export function filterIcon(): SVGSVGElement {
  return icon('filter-icon',
    node('path', { d: 'M2.5 4h11M4.5 8h7M6.5 12h3', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round' }))
}

/** Sliders, for the Display button. */
export function displayIcon(): SVGSVGElement {
  return icon('display-icon',
    node('path', { d: 'M2.5 5h6M11.5 5h2M2.5 11h2M7.5 11h6', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round' }),
    node('circle', { cx: 10, cy: 5, r: 1.5, stroke: 'currentColor', 'stroke-width': 1.5 }),
    node('circle', { cx: 6, cy: 11, r: 1.5, stroke: 'currentColor', 'stroke-width': 1.5 }))
}

/** Columns side by side, for the Board view. */
export function boardIcon(): SVGSVGElement {
  return icon('board-icon',
    node('rect', { x: 2.5, y: 3, width: 3.25, height: 10, rx: 1, stroke: 'currentColor', 'stroke-width': 1.5 }),
    node('rect', { x: 8.25, y: 3, width: 3.25, height: 6.5, rx: 1, stroke: 'currentColor', 'stroke-width': 1.5 }))
}

/** Rows, for the List view. */
export function listIcon(): SVGSVGElement {
  return icon('list-icon',
    node('path', { d: 'M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01', stroke: 'currentColor', 'stroke-width': 1.75, 'stroke-linecap': 'round' }))
}

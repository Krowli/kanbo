/**
 * Which cards are picked for a change of several at once. Every function
 * returns a new selection; none changes the one it is given. The `anchor` is
 * the card a shift-click ranges from.
 */

export interface Selection {
  ids: ReadonlySet<string>
  anchor: string | null
}

export const EMPTY_SELECTION: Selection = { ids: new Set(), anchor: null }

export function isSelected(selection: Selection, id: string): boolean {
  return selection.ids.has(id)
}

/** Select a card, or take it out; either way it becomes the anchor. */
export function toggleSelection(selection: Selection, id: string): Selection {
  const ids = new Set(selection.ids)
  if (!ids.delete(id)) {
    ids.add(id)
  }
  return { ids, anchor: id }
}

/**
 * Select every card from the anchor to `id` in `order` (one column's, or one
 * group's, cards top to bottom), both ends included, added to what is picked.
 * With no anchor in that order it picks `id` alone.
 */
export function selectRange(selection: Selection, order: readonly string[], id: string): Selection {
  const to = order.indexOf(id)
  const from = selection.anchor === null ? -1 : order.indexOf(selection.anchor)
  const ids = new Set(selection.ids)
  if (to === -1 || from === -1) {
    ids.add(id)
    return { ids, anchor: id }
  }
  for (const picked of order.slice(Math.min(from, to), Math.max(from, to) + 1)) {
    ids.add(picked)
  }
  return { ids, anchor: selection.anchor }
}

/** Shift + a movement key: the focused card and the one the focus moves to are both picked. */
export function extendSelection(selection: Selection, focusedId: string, nextId: string): Selection {
  const ids = new Set(selection.ids)
  ids.add(focusedId)
  ids.add(nextId)
  return { ids, anchor: selection.anchor ?? focusedId }
}

export function clearSelection(): Selection {
  return EMPTY_SELECTION
}

/** After a refresh: keep only the cards that still exist. The same object comes back when none was lost. */
export function pruneSelection(selection: Selection, existing: ReadonlySet<string>): Selection {
  const kept = [...selection.ids].filter(id => existing.has(id))
  if (kept.length === selection.ids.size && (selection.anchor === null || existing.has(selection.anchor))) {
    return selection
  }
  return { ids: new Set(kept), anchor: selection.anchor !== null && existing.has(selection.anchor) ? selection.anchor : null }
}

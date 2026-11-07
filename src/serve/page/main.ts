import type { ServeProjectView } from '../projects'
import type { ServeCardView, ServeStatusView } from '../views'
import type { BoardApi, BulkChange } from './api'
import { ApiError, createBoardApi } from './api'
import { applyBulk } from './bulk'
import { renderCard } from './card-element'
import type { Display } from './display'
import { readDisplay, writeDisplay } from './display'
import { button, el } from './dom'
import type { Placement } from './enter'
import { enterOf, placementsOf, startsWaiting } from './enter'
import type { CardFilters } from './filters'
import { filterOptions, matchesFilters, readFilters, writeFilters } from './filters'
import { columnBadge, columnRules, countByStatus } from './column-badges'
import { lockIcon, plusIcon, statusIcon } from './icons'
import { readCollapsed, renderList, writeCollapsed } from './list-view'
import type { KeyboardHost } from './keyboard'
import { handleKey, isTypingTarget, readLayout } from './keyboard'
import { isPopoverOpen, closeOpenPopover } from './popover'
import { clearSelection, EMPTY_SELECTION, extendSelection, pruneSelection, selectRange, toggleSelection } from './selection'
import type { Selection } from './selection'
import { createSelectionBar } from './selection-bar'
import type { BoardColumn } from './grouping'
import { groupBoard, newCardStatus } from './grouping'
import type { CardDetail, PanelTab } from './panel'
import { readScroll, renderPanel } from './panel'
import { childrenOf, drawnCards, familyView, parentOf, runsBelow, subtaskBlock, subtaskRowsOf, subtaskSummary, waitsBelow } from './subtasks'
import { startPresence } from './presence'
import { renderProjectSwitcher, renderWhere } from './project-switcher'
import { createToolbar } from './toolbar'
import { adoptTokenFromLocation, readStoredToken, storeToken } from './token'

/**
 * The board page: the served workspace's columns and cards, a card's side
 * panel, and a poll of the board's version that reloads what changed.
 *
 * It holds no data of its own and no framework: every render builds the DOM
 * again from the last answers, with `textContent` for everything the board
 * holds. The two things a render must not throw away — a card being written in
 * a column, a note being written in the panel — are kept across it.
 */

/** How often the page asks whether the board changed, while the tab is visible. */
const POLL_INTERVAL_MS = 2000

adoptTokenFromLocation()
let token = readStoredToken()
/** The project the page shows: the `?project=` in its address, or the one the server was started in. */
let projectId: string | null = new URLSearchParams(location.search).get('project')
let projects: ServeProjectView[] = []
let workspaceInfo: { id: string, identifier: string, name: string } | null = null
/** What the top bar was last built from, so a poll that changed nothing leaves an open dropdown alone. */
let identityKey = ''
const api: BoardApi = createBoardApi(() => token, () => projectId === null ? '' : `/projects/${encodeURIComponent(projectId)}`)

/** What the bar above the board narrows the cards to; kept in the address so a reload shows the same. */
let filters: CardFilters = readFilters(location.search)
/** The List view's folded groups for this project, kept for the browser session. */
let collapsed: Set<string> = readStoredCollapsed()
/** How sub-tasks are shown; kept in the address too. */
let display: Display = readDisplay(location.search)

/** `sessionStorage`, or nothing where the browser refuses it. */
function sessionStore(): Storage | null {
  try {
    return window.sessionStorage
  }
  catch {
    return null
  }
}

function readStoredCollapsed(): Set<string> {
  const store = sessionStore()
  return store ? readCollapsed(store, projectId ?? 'default') : new Set()
}

function toggleGroup(groupId: string): void {
  collapsed = new Set(collapsed)
  if (!collapsed.delete(groupId)) {
    collapsed.add(groupId)
  }
  const store = sessionStore()
  if (store) {
    writeCollapsed(store, projectId ?? 'default', collapsed)
  }
  renderBoard()
}

/** The cards picked for a change of several at once. */
let selection: Selection = EMPTY_SELECTION

let statuses: ServeStatusView[] = []
let cards: ServeCardView[] = []
let seq: number | null = null
/** The token was refused or is missing: stop polling until the person gives one. */
let needsToken = false
/** The server did not answer at all: it has stopped, so polling it only repeats the failure. */
let serverGone = false
let refreshing = false

/** The column a new card is being written in, and the form it is written in. */
let draft: { statusId: string, form: HTMLElement, input: HTMLTextAreaElement } | null = null
let openCardId: string | null = null
let detail: CardDetail | null = null
let panelNotice: string | null = null
let draggedCardId: string | null = null

/** The last render's card placements, so only a card that is new or changed column moves; `null` before the first render. */
let lastPlacement: ReadonlyMap<string, Placement> | null = null

const root = document.querySelector<HTMLElement>('#app') ?? document.body
const header = el('header', 'topbar')
const tokenInput = el('input', 'field token-input')
const tokenToggle = button('Token', 'ghost token-toggle', () => {
  tokenUnfolded = !tokenUnfolded
  updateTokenFold()
  if (tokenUnfolded) {
    tokenInput.focus()
  }
})
const notice = el('p', 'notice')
const boardElement = el('main', 'board')
const panelHost = el('div', 'panel-host')
const projectSlot = el('span', 'project-slot')
const filterSlot = el('div', 'filter-slot')
const selectionBar = createSelectionBar({
  onMove: (statusId) => {
    const column = statuses.find(status => status.id === statusId)
    void changeSelected({ statusId }, column?.name)
  },
  onPriority: priority => void changeSelected({ priority }),
  onClear: () => changeSelection(clearSelection()),
})
const toolbar = createToolbar({
  onFilters: next => changeFilters(next),
  onDisplay: next => changeDisplay(next),
  onNew: () => {
    const status = newCardStatus(statuses)
    if (status) {
      openDraft(status)
    }
  },
})

/** The last load of the board worked. */
let loadWorked = false
/** The person opened the folded token form with its button. */
let tokenUnfolded = false

/**
 * Once a kept token has loaded the board, the token form may fold into its
 * "Token" button (only a narrow screen does, by CSS); a refused token, a
 * missing one or a failed load unfolds it again.
 */
function updateTokenFold(): void {
  if (token === null || needsToken || !loadWorked) {
    tokenUnfolded = false
    delete header.dataset.token
  }
  else {
    header.dataset.token = tokenUnfolded ? 'unfolded' : 'folded'
  }
  tokenToggle.setAttribute('aria-expanded', String(header.dataset.token !== 'folded'))
}

function mountShell(): void {
  root.classList.add('app')
  const title = el('h1', 'topbar-title', 'Kanbo')
  const workspace = el('span', 'workspace')
  workspace.id = 'workspace'
  projectSlot.id = 'project-switcher'

  const tokenForm = el('form', 'token-form')
  tokenForm.id = 'token-form'
  tokenToggle.setAttribute('aria-controls', tokenForm.id)
  tokenInput.type = 'password'
  tokenInput.autocomplete = 'off'
  tokenInput.placeholder = 'Server token'
  tokenInput.value = token ?? ''
  const tokenLabel = el('label', 'token-label', 'Token')
  tokenLabel.append(tokenInput)
  const save = el('button', 'secondary', 'Save')
  save.type = 'submit'
  tokenForm.append(tokenLabel, save)
  tokenForm.addEventListener('submit', (event) => {
    event.preventDefault()
    token = tokenInput.value.trim() || null
    storeToken(token)
    needsToken = false
    tokenUnfolded = false
    showNotice(null)
    void refresh()
  })

  header.append(title, projectSlot, tokenToggle, workspace, tokenForm)
  updateTokenFold()
  notice.setAttribute('role', 'status')
  notice.hidden = true
  filterSlot.append(toolbar.element)
  root.replaceChildren(header, notice, filterSlot, boardElement, selectionBar.element, panelHost)
}

/** Whether the notice on screen says the board could not be loaded, so that the next good load takes it away. */
let loadFailed = false

function showNotice(text: string | null, kind: 'info' | 'error' = 'info'): void {
  notice.textContent = text ?? ''
  notice.hidden = !text
  notice.dataset.kind = kind
  loadFailed = false
}

/** What a failed request says to the person, asking for the token when that is what is missing. */
function describeFailure(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'server_unreachable') {
      serverGone = true
      return error.message
    }
    if (error.status === 401) {
      needsToken = true
      // Unfolded first: a folded field cannot take the focus.
      updateTokenFold()
      tokenInput.focus()
      return 'This server needs its token. Enter it in the Token field above.'
    }
    return error.message
  }
  return error instanceof Error ? error.message : String(error)
}

function showLoadFailure(error: unknown): void {
  showNotice(describeFailure(error), 'error')
  loadFailed = true
  loadWorked = false
  updateTokenFold()
}

/** A load worked: take away the notice that said it had not. */
function clearLoadFailure(): void {
  loadWorked = true
  updateTokenFold()
  if (loadFailed) {
    loadFailed = false
    showNotice(null)
  }
}

async function refresh(): Promise<void> {
  if (refreshing) {
    return
  }
  refreshing = true
  try {
    // The version first: a change landing while the rest loads is seen by the next poll.
    const version = await api.version()
    const [nextStatuses, nextCards, nextProjects, nextWorkspace] = await Promise.all([api.statuses(), api.cards(), api.projects(), api.workspace()])
    seq = version
    statuses = nextStatuses
    cards = nextCards
    // A card that was picked and is gone stays out; the rest stay picked.
    selection = pruneSelection(selection, new Set(nextCards.map(card => card.id)))
    projects = nextProjects
    workspaceInfo = nextWorkspace
    renderBoard()
    clearLoadFailure()
    if (openCardId) {
      await loadDetail()
    }
  }
  catch (error) {
    if (!fallBackToDefaultProject(error)) {
      showLoadFailure(error)
    }
  }
  finally {
    refreshing = false
  }
  if (fellBack) {
    fellBack = false
    await refresh()
  }
}

let fellBack = false

/** The project in the address left the computer's list while the page was open: show the default one and say so. */
function fallBackToDefaultProject(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.code !== 'project_not_found' || projectId === null) {
    return false
  }
  const fallback = projects.find(project => project.isDefault)
  chooseProject(null)
  showNotice(`That project is no longer on this computer's list; showing ${fallback?.name ?? 'the board this server was started on'}.`)
  fellBack = true
  return true
}

/** Show another project (`null`: the one the server was started in) from a clean slate. */
function chooseProject(id: string | null): void {
  projectId = id
  const url = new URL(location.href)
  if (id === null) {
    url.searchParams.delete('project')
  }
  else {
    url.searchParams.set('project', id)
  }
  // Who works a card and which labels exist belong to a project; the rest of the filters carry over.
  filters = { ...filters, worker: null, labels: [] }
  collapsed = readStoredCollapsed()
  selection = EMPTY_SELECTION
  writeFiltersToAddress(url)
  seq = null
  draft = null
  closePanel()
  statuses = []
  cards = []
  // Another project's first render moves nothing, like the page's first.
  lastPlacement = null
  workspaceInfo = null
  identityKey = ''
  showNotice(null)
}

async function poll(): Promise<void> {
  if (document.visibilityState !== 'visible' || needsToken || serverGone || refreshing) {
    return
  }
  try {
    if (await api.version() !== seq) {
      await refresh()
    }
    else {
      clearLoadFailure()
    }
  }
  catch (error) {
    if (fallBackToDefaultProject(error)) {
      await refresh()
    }
    else {
      showLoadFailure(error)
    }
  }
}

/** The top bar's project switcher and the line saying where this board lives. */
function renderIdentity(): void {
  // Never a guess: with no project named and none the server's own, nothing is "current".
  const current = projectId === null
    ? projects.find(project => project.isDefault) ?? null
    : projects.find(project => project.id === projectId) ?? null
  const key = JSON.stringify([projects, projectId, current?.id, workspaceInfo])
  if (key === identityKey) {
    return
  }
  identityKey = key
  const hasDefault = projects.some(project => project.isDefault)
  const choose = (id: string): void => {
    chooseProject(id === '' ? null : id)
    void refresh()
  }
  projectSlot.replaceChildren(...(projects.length > (hasDefault ? 1 : 0)
    ? [renderProjectSwitcher(projects, current?.id ?? null, choose, hasDefault ? null : { name: projectId === null ? workspaceInfo?.name ?? null : null })]
    : []))
  const where = document.querySelector('#workspace')
  if (where) {
    where.replaceChildren(...(workspaceInfo ? [renderWhere(current, workspaceInfo)] : []))
  }
}

/** Put the filters into the address (keeping `project` and whatever else is there) without adding a history entry. */
function writeFiltersToAddress(url: URL = new URL(location.href)): void {
  history.replaceState(null, '', `${url.pathname}${writeDisplay(display, writeFilters(filters, url.search))}${url.hash}`)
}

function changeFilters(next: CardFilters): void {
  filters = next
  writeFiltersToAddress()
  renderBoard()
}

function changeDisplay(next: Display): void {
  display = next
  writeFiltersToAddress()
  renderBoard()
}

function renderBoard(): void {
  renderIdentity()
  const draftHadFocus = draft !== null && document.activeElement === draft.input
  const focusedCardId = document.activeElement?.closest<HTMLElement>('.card, .list-row')?.dataset.cardId ?? null
  // A family goes together: a parent shows when it or a sub-task matches.
  const family = familyView(cards, display.subtasks, card => matchesFilters(card, filters))
  const shown = drawnCards(cards, display.subtasks).filter(card => family.drawn.has(card.id))
  toolbar.update({ filters, display, options: filterOptions(cards), counts: { shown: family.count, total: cards.length } })
  // A column counts the cards that are in it, a sub-task drawn inside a parent elsewhere included.
  const tally = { shown: countByStatus(cards, card => matchesFilters(card, filters)), total: countByStatus(cards) }
  const groups = groupBoard(statuses, shown)
  boardElement.dataset.view = display.view
  if (display.view === 'list') {
    const list = renderList({
      statuses,
      cards,
      groups,
      mode: display.subtasks,
      faded: family.faded,
      collapsed,
      tally,
      now: Math.floor(Date.now() / 1000),
      onToggleGroup: toggleGroup,
      onOpen: id => void openCard(id),
    })
    if (draft) {
      draft.form.classList.add('list-draft')
      list.prepend(draft.form)
    }
    boardElement.replaceChildren(list)
  }
  else {
    boardElement.replaceChildren(...groups.map(column => renderColumn(column, family.faded, tally)))
  }
  // Every card, shown or not: a filter that brings a card into view does not make it new.
  lastPlacement = placementsOf(cards)
  markOpenCard()
  markSelection()

  if (draftHadFocus) {
    draft?.input.focus()
  }
  else if (focusedCardId) {
    focusCard(focusedCardId)
  }
}

/** The picked cards carry `data-selected` and a ticked box, and the bar says how many. */
function markSelection(): void {
  for (const card of boardElement.querySelectorAll<HTMLElement>('.card, .list-row')) {
    const picked = card.dataset.cardId !== undefined && selection.ids.has(card.dataset.cardId)
    card.toggleAttribute('data-selected', picked)
    const box = card.querySelector<HTMLInputElement>('input.select-box')
    if (box) {
      box.checked = picked
    }
  }
  selectionBar.update({ count: selection.ids.size, statuses })
}

function changeSelection(next: Selection): void {
  selection = next
  markSelection()
}

/** Change every picked card at once, as one write, and say which went in short of a column's rules. */
async function changeSelected(change: BulkChange, column?: string): Promise<void> {
  try {
    showNotice(await applyBulk(api, [...selection.ids], change, { column }))
  }
  catch (error) {
    showNotice(describeFailure(error), 'error')
  }
  await refresh()
}

/** Shift-click: pick the cards from the anchor to this one within its column or group. */
function selectThrough(row: HTMLElement, cardId: string): void {
  const container = row.closest('.column-cards, .list-group')
  const order = [...(container ?? boardElement).querySelectorAll<HTMLElement>('[data-card-id]')].map(item => item.dataset.cardId!)
  changeSelection(selectRange(selection, order, cardId))
}

// Capture phase: a shift- or cmd-click picks a card instead of opening it.
boardElement.addEventListener('click', (event) => {
  const target = event.target as HTMLElement
  const row = target.closest<HTMLElement>('.card, .list-row')
  const cardId = row?.dataset.cardId
  if (!row || !cardId) {
    return
  }
  if (event.shiftKey || event.metaKey || event.ctrlKey) {
    if (target.closest('.subtask-row, .subtask-more, .subtask-strip')) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    if (event.shiftKey) {
      selectThrough(row, cardId)
    }
    else {
      changeSelection(toggleSelection(selection, cardId))
    }
  }
  else if (target.classList.contains('select-box')) {
    changeSelection(toggleSelection(selection, cardId))
  }
}, true)

/** The card whose panel is open carries `data-open`, so it reads as open on the board. */
function markOpenCard(): void {
  for (const card of boardElement.querySelectorAll<HTMLElement>('.card, .list-row')) {
    card.toggleAttribute('data-open', card.dataset.cardId === openCardId)
  }
}

function focusCard(cardId: string): void {
  for (const card of boardElement.querySelectorAll<HTMLElement>('.card, .list-row')) {
    if (card.dataset.cardId === cardId) {
      card.querySelector<HTMLElement>('.card-title, .list-title')?.focus()
    }
  }
}

function renderColumn(column: BoardColumn, faded: ReadonlySet<string>, tally: { shown: ReadonlyMap<string, number>, total: ReadonlyMap<string, number> }): HTMLElement {
  const element = el('section', 'column')
  element.setAttribute('aria-label', column.name)
  const head = el('header', 'column-head')
  const status = column.status
  const badge = columnBadge(status, status ? tally.shown.get(status.id) ?? 0 : column.cards.length, status ? tally.total.get(status.id) ?? 0 : column.cards.length)
  const count = el('span', 'column-count', badge.text)
  count.toggleAttribute('data-full', badge.full)
  if (status?.wipLimit != null) {
    count.title = `${tally.total.get(status.id) ?? 0} of ${status.wipLimit} cards`
  }
  head.append(statusIcon(status?.category ?? null), el('span', 'column-name', column.name), count)
  const rules = status ? columnRules(status, statuses) : null
  if (rules) {
    const lock = el('span', 'column-lock')
    lock.append(lockIcon())
    lock.title = rules
    lock.setAttribute('role', 'img')
    lock.setAttribute('aria-label', rules.replaceAll('\n', '. '))
    head.append(lock)
  }
  head.append(el('span', 'spacer'))
  if (status) {
    const add = el('button', 'ghost column-add')
    add.type = 'button'
    add.append(plusIcon())
    add.setAttribute('aria-label', `New card in ${column.name}`)
    add.title = `New card in ${column.name}`
    add.addEventListener('click', () => openDraft(status))
    head.append(add)
  }
  const list = el('div', 'column-cards')
  if (draft && draft.statusId === column.id) {
    list.append(draft.form)
  }
  for (const card of column.cards) {
    const inside = display.subtasks === 'inside'
    const cardElement = renderCard(card, status?.category ?? null, opened => void openCard(opened.id), {
      parent: parentOf(cards, card),
      summary: subtaskSummary(cards, statuses, card.id),
      onOpenCard: id => void openCard(id),
      block: inside ? subtaskBlock(cards, statuses, card.id, faded) ?? undefined : undefined,
      waitsBelow: inside && waitsBelow(cards, card.id),
      runsBelow: inside && runsBelow(cards, card.id),
    })
    const enter = enterOf(lastPlacement, card)
    if (enter) {
      cardElement.dataset.enter = enter
    }
    if (startsWaiting(lastPlacement, card)) {
      cardElement.querySelector<HTMLElement>('.waiting-pill')?.setAttribute('data-enter', 'waiting')
    }
    cardElement.addEventListener('dragstart', (event) => {
      draggedCardId = card.id
      event.dataTransfer?.setData('text/plain', card.id)
      cardElement.classList.add('dragging')
    })
    cardElement.addEventListener('dragend', () => {
      draggedCardId = null
      cardElement.classList.remove('dragging')
    })
    list.append(cardElement)
  }
  element.append(head, list)

  if (status) {
    element.addEventListener('dragover', (event) => {
      if (draggedCardId) {
        event.preventDefault()
        element.classList.add('drop-target')
      }
    })
    element.addEventListener('dragleave', (event) => {
      if (!element.contains(event.relatedTarget as Node | null)) {
        element.classList.remove('drop-target')
      }
    })
    element.addEventListener('drop', (event) => {
      event.preventDefault()
      element.classList.remove('drop-target')
      const cardId = draggedCardId
      draggedCardId = null
      if (cardId) {
        void moveCard(cardId, status)
      }
    })
  }
  return element
}

async function moveCard(cardId: string, status: ServeStatusView): Promise<void> {
  if (cards.find(card => card.id === cardId)?.statusId === status.id) {
    return
  }
  try {
    const moved = await api.moveCard(cardId, status.id)
    const unmet = moved.unmetRules ?? []
    showNotice(unmet.length > 0
      ? `${moved.id} is in ${status.name}, but still misses: ${unmet.map(rule => rule.detail).join('; ')}`
      : null)
  }
  catch (error) {
    showNotice(describeFailure(error), 'error')
  }
  await refresh()
}

/** Open the new-card form at the top of a column: a description, and the board gives the key. */
function openDraft(status: ServeStatusView): void {
  const form = el('div', 'draft')
  const input = el('textarea', 'field')
  input.rows = 3
  input.placeholder = 'Describe the card'
  input.setAttribute('aria-label', `New card in ${status.name}`)
  const create = async (): Promise<void> => {
    const description = input.value.trim()
    if (!description) {
      input.focus()
      return
    }
    try {
      const created = await api.createCard({ workspaceId: status.workspaceId, statusId: status.id, description })
      draft = null
      showNotice(created.unmetRules?.length
        ? `${created.id} is in ${status.name}, but still misses: ${created.unmetRules.map(rule => rule.detail).join('; ')}`
        : null)
    }
    catch (error) {
      showNotice(describeFailure(error), 'error')
    }
    await refresh()
  }
  const cancel = (): void => {
    draft = null
    renderBoard()
  }
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      void create()
    }
    else if (event.key === 'Escape') {
      event.stopPropagation()
      cancel()
    }
  })
  const row = el('div', 'row')
  row.append(button('Create', 'primary', () => void create()), button('Cancel', 'ghost', cancel))
  form.append(input, row)
  draft = { statusId: status.id, form, input }
  renderBoard()
  input.focus()
}

/** The tab the dialog is on; kept from card to card, so reading History card after card stays on History. */
let panelTab: PanelTab = 'comments'

async function openCard(cardId: string): Promise<void> {
  openCardId = cardId
  panelNotice = null
  markOpenCard()
  await loadDetail()
}

async function loadDetail(): Promise<void> {
  const cardId = openCardId
  const card = cards.find(candidate => candidate.id === cardId)
  if (!cardId || !card) {
    closePanel()
    return
  }
  // A note being written is not thrown away by a change somebody else made.
  if (detail?.card.id === cardId && hasUnsentText(panelHost)) {
    return
  }
  try {
    const [comments, activity, runs, fieldChanges] = await Promise.all([api.comments(cardId), api.activity(cardId), api.runs(cardId), api.fieldChanges(cardId)])
    detail = { card, status: statuses.find(status => status.id === card.statusId) ?? null, comments, activity, runs, fieldChanges, parent: parentOf(cards, card), subtasks: subtaskRowsOf(cards, statuses, cardId), summary: subtaskSummary(cards, statuses, cardId), siblings: card.parentIssueId && card.parentIssueId !== cardId ? childrenOf(cards, statuses, card.parentIssueId) : [], statuses, tab: panelTab }
  }
  catch (error) {
    panelNotice = describeFailure(error)
  }
  renderPanelHost()
}

function hasUnsentText(container: HTMLElement): boolean {
  return [...container.querySelectorAll('textarea')].some(area => area.value.trim() !== '' || document.activeElement === area)
}

function renderPanelHost(): void {
  if (!detail || detail.card.id !== openCardId) {
    panelHost.replaceChildren()
    setBackgroundInert(false)
    return
  }
  const cardId = detail.card.id
  const panel = renderPanel(detail, {
    close: closePanel,
    addComment: content => void act(async () => {
      await api.addComment(cardId, content)
    }),
    approve: comment => void act(async () => {
      await api.approve(cardId, comment)
    }),
    returnCard: comment => void act(async () => {
      await api.returnCard(cardId, comment)
    }),
    openCard: id => void openCard(id),
    selectTab: (tab) => {
      panelTab = tab
      if (detail) {
        detail = { ...detail, tab }
      }
    },
  }, panelNotice)
  const opening = !panelHost.firstChild
  const previousTop = readScroll(panelHost, cardId)
  panelHost.replaceChildren(panel)
  const scroller = panel.querySelector<HTMLElement>('.panel-scroll')
  if (scroller) {
    scroller.scrollTop = previousTop
  }
  if (opening) {
    setBackgroundInert(true)
    // Fades in this once; the rebuilds on later polls stay still.
    panel.classList.add('panel--opening')
    // The dialog itself takes the focus, so no control shows a ring before the person has used the keyboard.
    panel.tabIndex = -1
    panel.focus()
  }
}

/** A person's action from the panel; a refusal for want of the token says so. */
async function act(action: () => Promise<void>): Promise<void> {
  try {
    await action()
    panelNotice = null
    // What was written is sent: the panel may be rebuilt from the new answers.
    for (const area of panelHost.querySelectorAll('textarea')) {
      area.value = ''
    }
  }
  catch (error) {
    const message = describeFailure(error)
    panelNotice = error instanceof ApiError && error.status === 403
      ? `${message} Needs the server token: only a request holding the token this server was started with acts for a person.`
      : message
    const shown = panelHost.querySelector<HTMLElement>('.panel-notice')
    if (shown) {
      shown.textContent = panelNotice
      shown.hidden = false
    }
    return
  }
  await refresh()
}

/** While the dialog is open the board behind it can't be reached by Tab or a screen reader. */
function setBackgroundInert(inert: boolean): void {
  for (const region of [header, notice, filterSlot, boardElement, selectionBar.element]) {
    region.inert = inert
  }
}

panelHost.addEventListener('click', (event) => {
  if (event.target === panelHost) {
    closePanel()
  }
})

function closePanel(): void {
  const cardId = openCardId
  openCardId = null
  detail = null
  panelNotice = null
  panelHost.replaceChildren()
  setBackgroundInert(false)
  markOpenCard()
  if (cardId) {
    focusCard(cardId)
  }
}

const keyboardHost: KeyboardHost = {
  layout: () => readLayout(boardElement),
  focusedId: () => (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.card, .list-row')?.dataset.cardId ?? null,
  focus: focusCard,
  state: () => ({ typing: isTypingTarget(document.activeElement), popoverOpen: isPopoverOpen(), dialogOpen: openCardId !== null, hasSelection: selection.ids.size > 0 }),
  open: cardId => void openCard(cardId),
  toggle: cardId => changeSelection(toggleSelection(selection, cardId)),
  extend: (from, to) => changeSelection(extendSelection(selection, from, to)),
  search: () => filterSlot.querySelector<HTMLInputElement>('.filter-search')?.focus(),
  closeDialog: closePanel,
  closePopover: () => void closeOpenPopover(),
  clearSelection: () => changeSelection(clearSelection()),
}
document.addEventListener('keydown', event => void handleKey(event, keyboardHost))
// Space opens a card on keydown (above); its button would otherwise click again when the key comes up.
document.addEventListener('keyup', (event) => {
  if (event.key === ' ' && event.target instanceof HTMLElement && event.target.closest('.card-title, .list-title')) {
    event.preventDefault()
  }
})
document.addEventListener('visibilitychange', () => void poll())

mountShell()
void refresh()
setInterval(() => void poll(), POLL_INTERVAL_MS)
// Last, so nothing presence does can keep the board from loading.
startPresence(() => token)

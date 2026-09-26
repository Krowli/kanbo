import type { ServeCardView, ServeStatusView } from '../views'
import type { BoardApi } from './api'
import { ApiError, createBoardApi } from './api'
import { renderCard } from './card-element'
import { button, el } from './dom'
import type { BoardColumn } from './grouping'
import { groupBoard } from './grouping'
import type { CardDetail } from './panel'
import { renderPanel } from './panel'
import { readStoredToken, storeToken } from './token'

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

let token = readStoredToken()
const api: BoardApi = createBoardApi(() => token)

let statuses: ServeStatusView[] = []
let cards: ServeCardView[] = []
let seq: number | null = null
/** The token was refused or is missing: stop polling until the person gives one. */
let needsToken = false
let refreshing = false

/** The column a new card is being written in, and the form it is written in. */
let draft: { statusId: string, form: HTMLElement, input: HTMLTextAreaElement } | null = null
let openCardId: string | null = null
let detail: CardDetail | null = null
let panelNotice: string | null = null
let draggedCardId: string | null = null

const root = document.querySelector<HTMLElement>('#app') ?? document.body
const tokenInput = el('input', 'field token-input')
const notice = el('p', 'notice')
const boardElement = el('main', 'board')
const panelHost = el('div', 'panel-host')

function mountShell(): void {
  const header = el('header', 'topbar')
  const title = el('h1', 'topbar-title', 'Kanbo')
  const workspace = el('span', 'workspace')
  workspace.id = 'workspace'

  const tokenForm = el('form', 'token-form')
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
    showNotice(null)
    void refresh()
  })

  header.append(title, workspace, tokenForm)
  notice.setAttribute('role', 'status')
  notice.hidden = true
  root.replaceChildren(header, notice, boardElement, panelHost)
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
    if (error.status === 401) {
      needsToken = true
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
}

function clearLoadFailure(): void {
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
    const [nextStatuses, nextCards] = await Promise.all([api.statuses(), api.cards()])
    seq = version
    statuses = nextStatuses
    cards = nextCards
    renderBoard()
    clearLoadFailure()
    if (openCardId) {
      await loadDetail()
    }
  }
  catch (error) {
    showLoadFailure(error)
  }
  finally {
    refreshing = false
  }
}

async function poll(): Promise<void> {
  if (document.visibilityState !== 'visible' || needsToken || refreshing) {
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
    showLoadFailure(error)
  }
}

function renderBoard(): void {
  const workspace = document.querySelector('#workspace')
  if (workspace) {
    workspace.textContent = statuses[0]?.workspaceId ?? ''
  }
  const draftHadFocus = draft !== null && document.activeElement === draft.input
  const focusedCardId = document.activeElement?.closest<HTMLElement>('.card')?.dataset.cardId ?? null

  boardElement.replaceChildren(...groupBoard(statuses, cards).map(renderColumn))

  if (draftHadFocus) {
    draft?.input.focus()
  }
  else if (focusedCardId) {
    focusCard(focusedCardId)
  }
}

function focusCard(cardId: string): void {
  for (const card of boardElement.querySelectorAll<HTMLElement>('.card')) {
    if (card.dataset.cardId === cardId) {
      card.querySelector<HTMLElement>('.card-title')?.focus()
    }
  }
}

function renderColumn(column: BoardColumn): HTMLElement {
  const element = el('section', 'column')
  element.setAttribute('aria-label', column.name)
  const head = el('header', 'column-head')
  head.append(el('span', 'column-name', column.name), el('span', 'column-count', String(column.cards.length)))
  const status = column.status
  if (status) {
    const add = button('+ New', 'ghost column-add', () => openDraft(status))
    add.setAttribute('aria-label', `New card in ${column.name}`)
    head.append(add)
  }
  const list = el('div', 'column-cards')
  if (draft && draft.statusId === column.id) {
    list.append(draft.form)
  }
  for (const card of column.cards) {
    const cardElement = renderCard(card, status?.category ?? null, opened => void openCard(opened.id))
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

async function openCard(cardId: string): Promise<void> {
  openCardId = cardId
  panelNotice = null
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
    const [comments, activity, runs] = await Promise.all([api.comments(cardId), api.activity(cardId), api.runs(cardId)])
    detail = { card, status: statuses.find(status => status.id === card.statusId) ?? null, comments, activity, runs }
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
  }, panelNotice)
  const opening = !panelHost.firstChild
  panelHost.replaceChildren(panel)
  if (opening) {
    panel.querySelector<HTMLElement>('button')?.focus()
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

function closePanel(): void {
  const cardId = openCardId
  openCardId = null
  detail = null
  panelNotice = null
  panelHost.replaceChildren()
  if (cardId) {
    focusCard(cardId)
  }
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && openCardId) {
    closePanel()
  }
})
document.addEventListener('visibilitychange', () => void poll())

mountShell()
void refresh()
setInterval(() => void poll(), POLL_INTERVAL_MS)

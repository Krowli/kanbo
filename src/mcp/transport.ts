import type { EntryRule } from '../domain/entry-rules'
import { ENTRY_RULES, readEntryRules } from '../domain/entry-rules'
import { normalizeStatusName } from '../domain/status-name'
import type { Issue, IssueRun } from '../sqlite/schema'

/**
 * What the board's tools ask for, and what comes back.
 *
 * A tool knows one operation and nothing about how it is performed: the same
 * `kanbo_card_move` runs against a server over HTTP inside an app's own MCP
 * server, and against the board itself inside `kanbo mcp`, because both transports answer this interface. Which one a tool
 * holds is the caller's decision, made once, and no tool can tell the
 * difference.
 *
 * The workspace is not a parameter here. Each transport is built for one board
 * — the CLI resolves it the way every `kanbo` command does, the server takes
 * it from the runtime it was launched for — and a tool that could name a
 * workspace could name one the agent was never given.
 */

/** A card, as a tool hands it to an agent. */
export interface KanboCardResult {
  /** The issue key, which is also the row id: `MAN-012`. */
  id: string
  number: number
  title: string
  description: string | null
  /** The column's name, `null` when the card sits in no column. */
  column: string | null
  /** The same column as the slug `kanbo_card_move` takes. */
  columnSlug: string | null
  statusLine: string | null
  waitingFor: 'human' | null
  priority: Issue['priority']
  labels: string[]
  executionMode: Issue['executionMode']
  parentIssueId: string | null
  /** Every run the card has ever had; the next launch is attempt `attemptCount + 1`. */
  attemptCount: number
  /** The run going on right now, `null` when nobody is working on the card. */
  activeRun: KanboActiveRunResult | null
  updatedAt: number
}

/**
 * A card read on its own, as `kanbo_card_get` hands it to an agent: the card,
 * and the sub-cards under it in board order. Its parent is `parentIssueId`.
 */
export interface KanboCardDetailResult extends KanboCardResult {
  subCards: Pick<KanboCardResult, 'id' | 'title' | 'columnSlug'>[]
}

/** The run of a card that is going on right now. */
export interface KanboActiveRunResult {
  id: string
  agentName: string
  state: IssueRun['state']
  executionMode: IssueRun['executionMode']
  branch: string | null
  startedAt: number
}

/**
 * A column of the board, as a tool hands it to an agent.
 *
 * What the column means is its description, written for exactly this reader;
 * the category behind it is the board's own classification of the column and says
 * nothing an agent moving a card can act on.
 */
export interface KanboColumnResult {
  id: string
  name: string
  /** What `kanbo_card_move` calls this column. */
  slug: string
  description: string | null
  order: number
  /** What a card must satisfy before an agent may move it here; empty for nothing. */
  entryRules: EntryRule[]
}

/**
 * A milestone read as a sprint, as `kanbo_sprints` hands it to an agent: its
 * dates (unix seconds), whether it is the one running now, and how many of its
 * cards are still open and how many are done.
 */
export interface KanboSprintResult {
  id: string
  title: string
  status: 'open' | 'closed'
  startDate: number | null
  dueDate: number | null
  current: boolean
  openCards: number
  doneCards: number
}

/** A comment, as `kanbo_card_comment` hands it back. */
export interface KanboCommentResult {
  id: string
  issueId: string
  content: string
  createdAt: number
}

/** A pull request a card names, as the pull-request tools hand it back. */
export interface KanboPullRequestResult {
  id: string
  issueId: string
  owner: string
  repo: string
  number: number
  url: string
  createdAt: number
}

/** One launch of a card, as the run tools hand it back. */
export interface KanboRunResult {
  id: string
  issueId: string
  agentName: string
  state: IssueRun['state']
  executionMode: IssueRun['executionMode']
  branch: string | null
  startedAt: number
  endedAt: number | null
  /** Where the caller's own log of this run lives, if it said — `claude:<id>` or `codex:<id>` (ruling 7-1), else `null`. */
  externalSessionRef: string | null
}

/**
 * What each tool asks its transport for. They are named rather than written
 * inline so the interface below reads as a list of operations, and kept inside
 * this module because a caller reaches them through `KanboToolTransport`.
 */

/** What `kanbo_card_create` needs to open a card. */
interface KanboCardCreateInput {
  /** Optional: a card without one is titled with its own key. */
  title?: string
  description?: string
  /** The column to open it in, by slug or name; the board's first column when absent. */
  column?: string
  /** The card this one belongs under, making it a sub-card. */
  parent?: string
  executionMode?: Issue['executionMode']
}

/** The fields `kanbo_card_update` may change. */
interface KanboCardUpdateInput {
  card: string
  title?: string
  description?: string
  priority?: Issue['priority']
  labels?: string[]
  executionMode?: Issue['executionMode']
}

/** What `kanbo_run_start` records about a launch. */
interface KanboRunStartInput {
  card: string
  agent: string
  branch?: string
  executionMode?: Issue['executionMode']
  /** Where the agent's own log of this run lives: `claude:<id>` or `codex:<id>` (ruling 7-1). */
  session?: string
}

/** How `kanbo_run_finish` says a run ended. */
interface KanboRunFinishInput {
  run: string
  state: 'finished' | 'failed' | 'stopped'
  errorText?: string
}

/** One method per thing the board's tools do. Both transports answer all of it. */
export interface KanboToolTransport {
  prime: () => Promise<{ text: string }>
  ready: (input: { limit?: number }) => Promise<KanboCardResult[]>
  columns: () => Promise<KanboColumnResult[]>
  sprints: () => Promise<KanboSprintResult[]>
  cardGet: (input: { card: string }) => Promise<KanboCardDetailResult>
  cardList: (input: { column?: string, limit?: number }) => Promise<KanboCardResult[]>
  cardCreate: (input: KanboCardCreateInput) => Promise<KanboCardResult>
  cardUpdate: (input: KanboCardUpdateInput) => Promise<KanboCardResult>
  cardMove: (input: { card: string, column: string }) => Promise<KanboCardResult>
  cardComment: (input: { card: string, content: string }) => Promise<KanboCommentResult>
  cardLinkPullRequest: (input: { card: string, url: string }) => Promise<KanboPullRequestResult>
  cardPullRequests: (input: { card: string }) => Promise<KanboPullRequestResult[]>
  statusLine: (input: { card: string, text: string }) => Promise<KanboCardResult>
  waitApproval: (input: { card: string, text?: string }) => Promise<KanboCardResult>
  runStart: (input: KanboRunStartInput) => Promise<KanboRunResult>
  runFinish: (input: KanboRunFinishInput) => Promise<KanboRunResult>
}

/**
 * A card as either transport already has it: the row's own fields with the
 * labels decoded, plus what the run registry says about it.
 */
export interface KanboCardFacts {
  id: string
  number: number
  title: string
  description: string | null
  statusId: string | null
  statusLine: string | null
  waitingFor: 'human' | null
  priority: Issue['priority']
  labels: string[]
  executionMode: Issue['executionMode']
  parentIssueId: string | null
  updatedAt: number
  attemptCount: number
  activeRun: KanboActiveRunResult | null
}

/**
 * The card a tool prints, from the card a transport holds.
 *
 * Both transports project here so the JSON an agent reads is the same whether
 * it came from the server or from the board file — including the column, which
 * neither of them carries on the card itself: the row keeps a foreign key, and
 * an agent moving a card needs the slug.
 *
 * Every field is named rather than spread. A card the board file answers with
 * carries more than this — the agent and session ids behind a run among them —
 * and passing an object through by reference would print whatever it happened
 * to hold, which is both a different shape from the server's answer and host
 * facts the agent was never meant to see.
 */
export function projectKanboCard(card: KanboCardFacts, columns: KanboColumnResult[]): KanboCardResult {
  const column = columns.find(candidate => candidate.id === card.statusId) ?? null
  return {
    id: card.id,
    number: card.number,
    title: card.title,
    description: card.description,
    column: column?.name ?? null,
    columnSlug: column?.slug ?? null,
    statusLine: card.statusLine,
    waitingFor: card.waitingFor,
    priority: card.priority,
    labels: card.labels,
    executionMode: card.executionMode,
    parentIssueId: card.parentIssueId,
    attemptCount: card.attemptCount,
    activeRun: projectKanboActiveRun(card.activeRun),
    updatedAt: card.updatedAt,
  }
}

/** A sub-card, as the card above it lists it: enough to name it and read it next. */
export function projectKanboSubCard(
  card: Pick<KanboCardFacts, 'id' | 'title' | 'statusId'>,
  columns: KanboColumnResult[],
): KanboCardDetailResult['subCards'][number] {
  return {
    id: card.id,
    title: card.title,
    columnSlug: columns.find(candidate => candidate.id === card.statusId)?.slug ?? null,
  }
}

/** The run going on right now, as much of it as the agent working the card needs. */
function projectKanboActiveRun(run: KanboActiveRunResult | null): KanboActiveRunResult | null {
  return run === null
    ? null
    : {
        id: run.id,
        agentName: run.agentName,
        state: run.state,
        executionMode: run.executionMode,
        branch: run.branch,
        startedAt: run.startedAt,
      }
}

/**
 * One launch of a card, from the run row either transport holds.
 *
 * What the row carries beyond this — the worktree path, the chat session
 * driving it, who launched it — belongs to the host that launched the run, not
 * to the agent that asked for one.
 */
export function projectKanboRun(run: {
  id: string
  issueId: string
  agentName: string
  state: IssueRun['state']
  executionMode: IssueRun['executionMode']
  branch: string | null
  startedAt: number
  endedAt: number | null
  /** Absent from a server that predates it — reads the same as `null`. */
  externalSessionRef?: string | null
}): KanboRunResult {
  return {
    id: run.id,
    issueId: run.issueId,
    agentName: run.agentName,
    state: run.state,
    executionMode: run.executionMode,
    branch: run.branch,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    externalSessionRef: run.externalSessionRef ?? null,
  }
}

/**
 * A pull-request link, from the row either transport holds — without who made
 * it, which is the board's record rather than anything the agent acts on.
 */
export function projectKanboPullRequest(link: KanboPullRequestResult): KanboPullRequestResult {
  return {
    id: link.id,
    issueId: link.issueId,
    owner: link.owner,
    repo: link.repo,
    number: link.number,
    url: link.url,
    createdAt: link.createdAt,
  }
}

/** A sprint, from the one `listSprints` answers with on either end — the description and timestamps left behind. */
export function projectKanboSprint(sprint: {
  id: string
  title: string
  status: 'open' | 'closed'
  startDate: number | null
  dueDate: number | null
  current: boolean
  cards: { open: number, done: number }
}): KanboSprintResult {
  return {
    id: sprint.id,
    title: sprint.title,
    status: sprint.status,
    startDate: sprint.startDate,
    dueDate: sprint.dueDate,
    current: sprint.current,
    openCards: sprint.cards.open,
    doneCards: sprint.cards.done,
  }
}

/** A column of the board, from the row either transport holds. */
export function projectKanboColumn(column: {
  id: string
  name: string
  description: string | null
  order: number
  entryRules?: string | readonly string[] | null
}): KanboColumnResult {
  const stored = column.entryRules
  return {
    id: column.id,
    name: column.name,
    slug: normalizeStatusName(column.name),
    description: column.description,
    order: column.order,
    entryRules: typeof stored === 'object' && stored !== null
      ? ENTRY_RULES.filter(rule => stored.includes(rule))
      : readEntryRules({ entryRules: stored ?? null }),
  }
}

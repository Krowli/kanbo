import { randomUUID } from 'node:crypto'

import type { BoardRunProjection, BoardStore } from '../board-store'
import { BoardError } from '../domain/errors'
import { formatExternalSessionRef, parseExternalSessionRef } from '../domain/external-session-ref'
import { currentUnixSeconds } from '../domain/time'
import type { Issue, IssueRun } from '../sqlite/schema'
import type { BoardWriteScope } from './change-seq'
import { runBoardWrite } from './change-seq'
import type { BoardActor } from './types'
import { BOARD_ACTOR, insertComment, requireCard, toRunLaunchedByKind, writeStatusLine } from './types'

/** What is known about a run when it starts. */
export interface StartRunInput {
  agentName: string
  agentId?: string | null
  host?: string | null
  /** Defaults to the mode the card carries. */
  executionMode?: Issue['executionMode']
  /** Defaults to the actor's own kind and id. */
  launchedByKind?: IssueRun['launchedByKind']
  launchedById?: string | null
  chatSessionId?: string | null
  branch?: string | null
  worktreePath?: string | null
  /** Where the agent's own log of this run lives, if it said: `claude:<id>` or `codex:<id>` (ruling 7-1). */
  externalSessionRef?: string | null
}

/** What a run turned out to be running in, once the host knows. */
export interface AttachRunExecutionInput {
  chatSessionId?: string | null
  branch?: string | null
  worktreePath?: string | null
  /** Where the agent's own log of this run lives, if it said: `claude:<id>` or `codex:<id>` (ruling 7-1). */
  externalSessionRef?: string | null
}

/**
 * Read and normalize an `externalSessionRef` a caller passed in — `undefined`
 * when the input named nothing, `null` when it named nothing on purpose, and
 * the canonical `claude:<id>` / `codex:<id>` form otherwise. Checked before the
 * write starts, the same as an entry rule: a ref this build cannot parse back
 * changes nothing on the board.
 */
function readExternalSessionRef(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) {
    return value
  }
  return formatExternalSessionRef(parseExternalSessionRef(value))
}

/** How a run ended, and — for a failure or a stop — what to say about it. */
export interface FinishRunInput {
  state: 'finished' | 'failed' | 'stopped'
  errorText?: string | null
  /**
   * Why a `stopped` run ended, when the answer is neither a person pressing
   * stop nor the app that launched it tidying up quietly: the comment then reads
   * `Run stopped: <reason>` instead of `Run stopped`.
   */
  reason?: string
  /**
   * What the card says it is doing once that stop is recorded, whoever the
   * actor is. A stop with no line of its own leaves the rule as it was: the
   * person who pressed stop is named, and anything else says nothing.
   */
  statusLine?: string
}

/** The three ways a run ends, as the board stores them. */
export const RUN_FINISH_STATES = ['finished', 'failed', 'stopped'] as const

/**
 * The other words agents write for those three — `completed` above all — each
 * read as the state it means. Measured: agents wrote `completed` or `succeeded`
 * first in most runs they finished themselves (docs/performance.md).
 */
export const RUN_FINISH_STATE_SYNONYMS: Readonly<Record<string, FinishRunInput['state']>> = {
  completed: 'finished',
  succeeded: 'finished',
  success: 'finished',
  done: 'finished',
  error: 'failed',
  errored: 'failed',
  cancelled: 'stopped',
  canceled: 'stopped',
  aborted: 'stopped',
}

/** The finish state a word names — one of the three, or a synonym of one, any case — or `null` for none. */
export function readRunFinishState(value: string): FinishRunInput['state'] | null {
  const word = value.trim().toLowerCase()
  return RUN_FINISH_STATES.find(state => state === word)
    ?? (Object.hasOwn(RUN_FINISH_STATE_SYNONYMS, word) ? RUN_FINISH_STATE_SYNONYMS[word]! : null)
}

/** A run with the attempt number it is, counting from the card's first launch. */
export type BoardRunView = IssueRun & { attempt: number }

/** The status line written when a run fails with nothing to show for it. */
export const NO_REPORT_STATUS_LINE = 'agent exited with an error, no report'

/** What a launch writes as the card's status line, ahead of the agent's own name. */
export const LAUNCHED_STATUS_LINE_PREFIX = 'launched '

/** What a launch writes as the system comment, ahead of the agent, attempt and mode. */
export const RUN_STARTED_COMMENT_PREFIX = 'Run started: '

/** The system comment a run that finished cleanly writes. */
export const RUN_FINISHED_COMMENT = 'Run finished'

/** The system comment a failed run writes when it names no error text. */
export const RUN_FAILED_COMMENT = 'Run failed'

/** What a failed run writes as the system comment, ahead of its own error text. */
export const RUN_FAILED_COMMENT_PREFIX = 'Run failed: '

/** The system comment a stop writes when a person pressed stop. */
export const RUN_STOPPED_BY_YOU_COMMENT = 'Run stopped by you'

/** The system comment a stop writes when nobody in particular pressed it. */
export const RUN_STOPPED_COMMENT = 'Run stopped'

/** What a stop with a reason writes as the system comment, ahead of that reason. */
export const RUN_STOPPED_REASON_PREFIX = 'Run stopped: '

/** The status line a stop writes when a person pressed stop and named no line of their own. */
export const STOPPED_BY_YOU_STATUS_LINE = 'stopped by you'

/**
 * Record that the card is being worked on.
 *
 * The card gets a line saying who is on it and a comment naming the attempt, so
 * the board reads the same whether the agent was launched by an app or from
 * somewhere else entirely. The attempt number is simply how many runs the card
 * has had — a card whose runs were all launched elsewhere still counts them.
 */
export async function startRun<TStore extends BoardStore>(
  store: TStore,
  issueId: string,
  input: StartRunInput,
  actor: BoardActor,
  scope?: BoardWriteScope<TStore>,
): Promise<IssueRun> {
  // Checked before the write starts: a session ref this build cannot parse
  // back changes nothing.
  const externalSessionRef = readExternalSessionRef(input.externalSessionRef) ?? null
  return await runBoardWrite(store, async ({ tx }) => {
    const card = await requireCard(tx, issueId)
    const attempt = await tx.runs.countByIssue(issueId) + 1
    const executionMode = input.executionMode ?? card.executionMode

    const run = await tx.runs.create({
      id: randomUUID(),
      issueId,
      launchedByKind: input.launchedByKind ?? toRunLaunchedByKind(actor),
      launchedById: input.launchedById ?? actor.id ?? null,
      agentId: input.agentId ?? null,
      agentName: input.agentName,
      host: input.host ?? null,
      executionMode,
      branch: input.branch ?? null,
      worktreePath: input.worktreePath ?? null,
      state: 'running',
      chatSessionId: input.chatSessionId ?? null,
      externalSessionRef,
      startedAt: currentUnixSeconds(),
      endedAt: null,
    })

    await writeStatusLine(tx, card, `${LAUNCHED_STATUS_LINE_PREFIX}${input.agentName}`, BOARD_ACTOR)
    await insertComment(tx, {
      issueId,
      authorKind: 'system.run',
      content: `${RUN_STARTED_COMMENT_PREFIX}${input.agentName} · attempt ${attempt} · ${executionMode}`,
    })

    return run
  }, scope)
}

/**
 * Fill in what the host only learns after the run is already going — the session
 * driving it, the branch and the worktree it works in. A run that has already
 * ended is history, and history is not edited. The agent's own log is only ever
 * filled, never replaced or cleared, the same as in `recordRunSessionRef`.
 */
export async function attachRunExecution<TStore extends BoardStore>(
  store: TStore,
  runId: string,
  input: AttachRunExecutionInput,
  scope?: BoardWriteScope<TStore>,
): Promise<IssueRun> {
  // Checked before the write starts, the same as in `startRun`.
  const externalSessionRef = readExternalSessionRef(input.externalSessionRef)
  return await runBoardWrite(store, async ({ tx }) => {
    const run = await requireRun(tx, runId)
    if (run.state !== 'running') {
      throw new BoardError('board_run_already_finished', { runId, state: run.state })
    }

    const patch: Partial<IssueRun> = {}
    if (input.chatSessionId !== undefined) {
      patch.chatSessionId = input.chatSessionId
    }
    if (input.branch !== undefined) {
      patch.branch = input.branch
    }
    if (input.worktreePath !== undefined) {
      patch.worktreePath = input.worktreePath
    }
    if (externalSessionRef !== undefined && fillRunSessionRef(run, externalSessionRef)) {
      patch.externalSessionRef = externalSessionRef
    }
    if (Object.keys(patch).length > 0) {
      await tx.runs.update(runId, patch)
    }
    return await requireRun(tx, runId)
  }, scope)
}

/**
 * Name the log a run wrote, after the fact — the agent saying so with
 * `kanbo run attach-session`, or a person picking it out of the logs on this
 * machine once the run is over (ruling 7-2).
 *
 * Unlike `attachRunExecution`, this is allowed on a run that has ended: which
 * log the run wrote is part of its history, found later, not a change to it.
 * It only fills a run that named no log of its own. The same ref again changes
 * nothing; a different one is refused, because the first word on where the log
 * is may already have had a chat imported from it.
 */
export async function recordRunSessionRef<TStore extends BoardStore>(
  store: TStore,
  runId: string,
  ref: string,
  scope?: BoardWriteScope<TStore>,
): Promise<IssueRun> {
  // Checked before the write starts, the same as in `startRun`.
  const externalSessionRef = formatExternalSessionRef(parseExternalSessionRef(ref))
  return await runBoardWrite(store, async ({ tx }) => {
    const run = await requireRun(tx, runId)
    if (!fillRunSessionRef(run, externalSessionRef)) {
      return run
    }
    await tx.runs.update(runId, { externalSessionRef })
    return await requireRun(tx, runId)
  }, scope)
}

/**
 * Take back the log a run names — a person saying the one recorded was wrong.
 *
 * The one way past the fill-only rule, and so a person's alone: an agent that
 * could clear or swap a ref could point a card's history at any log it liked.
 * Without `replaceWith` the run names no log afterwards; with it, the run names
 * that one instead. Allowed on a run that has ended, like `recordRunSessionRef`.
 * Whatever chat was imported from the old ref is the host's to forget.
 */
export async function clearRunSessionRef<TStore extends BoardStore>(
  store: TStore,
  runId: string,
  actor: BoardActor,
  options: { replaceWith?: string } = {},
  scope?: BoardWriteScope<TStore>,
): Promise<IssueRun> {
  if (actor.kind !== 'user') {
    throw new BoardError('board_run_session_ref_requires_user', { runId, actorKind: actor.kind })
  }
  // Checked before the write starts, the same as in `startRun`.
  const externalSessionRef = readExternalSessionRef(options.replaceWith) ?? null
  return await runBoardWrite(store, async ({ tx }) => {
    const run = await requireRun(tx, runId)
    if (run.externalSessionRef === externalSessionRef) {
      return run
    }
    await tx.runs.update(runId, { externalSessionRef })
    return await requireRun(tx, runId)
  }, scope)
}

/**
 * Whether naming `ref` as the run's log writes anything — the one rule every
 * path that touches `externalSessionRef` follows (ruling 7-2): the ref is only
 * ever filled. Naming the one the run already carries, or naming none on a run
 * that carries none, changes nothing; replacing or clearing one it carries is
 * refused, because a chat may already have been imported from it.
 */
function fillRunSessionRef(run: IssueRun, ref: string | null): boolean {
  if (run.externalSessionRef === ref) {
    return false
  }
  if (run.externalSessionRef !== null) {
    throw new BoardError('board_run_session_ref_conflict', { runId: run.id, externalSessionRef: run.externalSessionRef })
  }
  return ref !== null
}

/**
 * End a run, and say on the card what that meant.
 *
 * Finishing is idempotent: a run that already ended comes back untouched, with
 * nothing written. An app that launches agents reaches this from several directions at once — the
 * session settling, a person pressing stop, a card being returned — and the
 * second of them must not double the comments or move the status line again.
 *
 * A completed run leaves the status line alone: whatever the agent last said it
 * was doing is a better final word than anything the app could write. A failure
 * only writes a line when nothing but the board wrote one since the launch,
 * because a card that says nothing after a crash is the one case where the
 * person looking at it learns nothing at all.
 */
export async function finishRun<TStore extends BoardStore>(
  store: TStore,
  runId: string,
  input: FinishRunInput,
  actor: BoardActor,
  scope?: BoardWriteScope<TStore>,
): Promise<IssueRun> {
  return await runBoardWrite(store, async ({ tx }) => {
    const run = await requireRun(tx, runId)
    if (run.state !== 'running') {
      return run
    }

    await tx.runs.update(runId, { state: input.state, endedAt: currentUnixSeconds() })
    const card = await requireCard(tx, run.issueId)
    await insertComment(tx, {
      issueId: run.issueId,
      authorKind: 'system.run',
      content: runComment(input, actor),
    })

    if (input.state === 'failed' && !await reportedSince(tx, run)) {
      await writeStatusLine(tx, card, NO_REPORT_STATUS_LINE, BOARD_ACTOR)
    }
    if (input.state === 'stopped') {
      const line = stoppedStatusLine(input, actor)
      if (line) {
        await writeStatusLine(tx, card, line, BOARD_ACTOR)
      }
    }

    return await requireRun(tx, runId)
  }, scope)
}

/** End every run of the card that is still going. Returns the runs that were stopped. */
export async function stopRunningRuns<TStore extends BoardStore>(
  store: TStore,
  issueId: string,
  actor: BoardActor,
  scope?: BoardWriteScope<TStore>,
): Promise<string[]> {
  return await runBoardWrite(store, async ({ tx }) => {
    const stopped: string[] = []
    for (const run of await tx.runs.listRunning(issueId)) {
      await finishRun(tx, run.id, { state: 'stopped' }, actor, { tx })
      stopped.push(run.id)
    }
    return stopped
  }, scope)
}

/** Every run of the card, oldest first, each carrying its attempt number. */
export async function listRuns(store: BoardStore, issueId: string): Promise<BoardRunView[]> {
  const runs = await store.runs.listByIssue(issueId)
  return runs.map((run, index) => ({ ...run, attempt: index + 1 }))
}

/** The run driving that chat session, for the facts an app learns session-first. */
export async function findRunByChatSessionId(store: BoardStore, chatSessionId: string): Promise<IssueRun | null> {
  return await store.runs.findByChatSessionId(chatSessionId)
}

/**
 * The run facts of a whole workspace in one statement: cards with no runs are
 * absent, because a sweep of the board only needs to hear about the ones that
 * have been launched.
 */
export async function readBoardProjection(store: BoardStore, workspaceId: string): Promise<BoardRunProjection[]> {
  return await store.runs.project({ workspaceId })
}

/** The run facts of the named cards, one entry per card asked for, in that order. */
export async function readBoardProjectionForIssues(store: BoardStore, issueIds: string[]): Promise<BoardRunProjection[]> {
  const found = new Map((await store.runs.project({ issueIds })).map(projection => [projection.issueId, projection]))
  return issueIds.map(issueId => found.get(issueId) ?? emptyProjection(issueId))
}

/** The run facts of one card, whether or not it has ever been launched. */
export async function readBoardProjectionForIssue(store: BoardStore, issueId: string): Promise<BoardRunProjection> {
  return (await readBoardProjectionForIssues(store, [issueId]))[0]
}

function emptyProjection(issueId: string): BoardRunProjection {
  return { issueId, attemptCount: 0, activeRun: null }
}

async function requireRun(store: BoardStore, runId: string): Promise<IssueRun> {
  const run = await store.runs.findById(runId)
  if (!run) {
    throw new BoardError('board_run_not_found', { runId })
  }
  return run
}

function runComment(input: FinishRunInput, actor: BoardActor): string {
  if (input.state === 'finished') {
    return RUN_FINISHED_COMMENT
  }
  if (input.state === 'failed') {
    return input.errorText ? `${RUN_FAILED_COMMENT_PREFIX}${input.errorText}` : RUN_FAILED_COMMENT
  }
  if (input.reason) {
    return `${RUN_STOPPED_REASON_PREFIX}${input.reason}`
  }
  return actor.kind === 'user' ? RUN_STOPPED_BY_YOU_COMMENT : RUN_STOPPED_COMMENT
}

/**
 * What the card says about itself once a stop is recorded, or nothing at all.
 *
 * A stop that names its own line writes it whoever the actor is: the card was
 * showing work going on, and what ended it — the launching app restarting, say — is a fact
 * about the card, not about the person who happened to be holding the button.
 * Without one the old rule stands: only a person pressing stop is named, and
 * the app tidying up leaves the card's last word alone.
 */
function stoppedStatusLine(input: FinishRunInput, actor: BoardActor): string | null {
  if (input.statusLine) {
    return input.statusLine
  }
  return actor.kind === 'user' ? STOPPED_BY_YOU_STATUS_LINE : null
}

/**
 * Did anything working this card say a word of its own since the run began?
 *
 * Not only the `agent` kind. An agent an app launched writes as `agent`, one a
 * provider target stands in for keeps that kind, and an agent launched from a
 * terminal or through `kanbo mcp` is stored as the system with a name — its
 * line is still the run's own report, and the last thing worth reading on a
 * card that then crashed. The board itself is the one writer that does not
 * count, and `BOARD_ACTOR` is the only one stored as the system with no name at
 * all, so that single pair is what this rules out.
 */
async function reportedSince(store: BoardStore, run: IssueRun): Promise<boolean> {
  const lines = await store.fieldChanges.listByIssueField(run.issueId, 'statusLine')
  return lines.some(line => line.createdAt >= run.startedAt
    && !(line.actorKind === 'system' && line.actorId === null))
}

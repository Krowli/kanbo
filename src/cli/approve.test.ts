import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BoardStore } from '../board-store'
import type { BoardWorkspaceIdentity } from '../domain/numbering'
import { createCard, waitApproval } from '../ops/cards'
import { readChangeSeq } from '../ops/change-seq'
import { startRun } from '../ops/runs'
import { createMilestone } from '../ops/sprints'
import type { BoardActor } from '../ops/types'
import { createSqliteBoardStore } from '../sqlite/board-store.sqlite'
import type { TestBoardDatabase } from '../testing/board-database'
import { createTestBoardDatabase, seedHostWorkspace } from '../testing/board-database'
import { describeApprovalRefusal, describeReturnRefusal, describeRunSessionRefRefusal, describeSprintCloseRefusal } from './actor'
import { registerApproveCommand } from './commands/approve'
import { registerReturnCommand } from './commands/return'
import { registerRunCommands } from './commands/run'
import { registerSprintCommands } from './commands/sprint'

const WORKSPACE: BoardWorkspaceIdentity = { id: 'workspace', identifier: 'WOR', name: 'Workspace' }
const AGENT: BoardActor = { kind: 'agent', id: 'agent-1' }

/** The variable that marks a shell as an agent's. */
const AGENT_SHELL = ['KANBO_ACTOR_KIND']

/** The marks agent tools leave in their agent's shell, each as documented: the variable, a value, and how the refusal names it. */
const AGENT_TOOL_MARKS = [
  ['CLAUDECODE', '1', 'CLAUDECODE=1'],
  ['GEMINI_CLI', '1', 'GEMINI_CLI=1'],
  ['CURSOR_AGENT', '1', 'CURSOR_AGENT'],
  ['CODEX_THREAD_ID', '019a0000-0000-7000-8000-000000000000', 'CODEX_THREAD_ID'],
] as const

describe('approving and returning from a terminal', () => {
  let board: TestBoardDatabase
  let store: BoardStore

  beforeEach(async () => {
    board = await createTestBoardDatabase()
    seedHostWorkspace(board, WORKSPACE.id, WORKSPACE.identifier)
    store = createSqliteBoardStore({ database: () => board.database })
    for (const name of [...AGENT_SHELL, ...AGENT_TOOL_MARKS.map(([variable]) => variable), 'KANBO_DB_PATH', 'KANBO_WORKSPACE_ID']) {
      vi.stubEnv(name, undefined)
    }
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    board.dispose()
  })

  /** A card that has been handed to a person and is waiting for one. */
  async function createWaitingCard() {
    const card = await createCard(store, { workspace: WORKSPACE, title: 'Card', statusName: 'In Review' }, AGENT)
    return await waitApproval(store, card.id, { statusLine: 'need a person' }, AGENT)
  }

  async function run(argv: string[]): Promise<void> {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const program = new Command().exitOverride()
    registerApproveCommand(program)
    registerReturnCommand(program)
    registerRunCommands(program)
    registerSprintCommands(program)
    await program.parseAsync(typed(argv), { from: 'user' })
  }

  /** The words `run` hands the program: what a person typed, and the board it names. */
  function typed(argv: string[]): string[] {
    return [...argv, '--db', board.path, '--workspace', WORKSPACE.id]
  }

  /** The refusal for `argv`, as the command line would print it: the command it names is the one typed. */
  function refusalOf(describe: (marker: string, command: string) => string, argv: string[], marker = 'KANBO_ACTOR_KIND=agent') {
    return expect.objectContaining({ exitCode: 4, message: describe(marker, ['kanbo', ...typed(argv)].join(' ')) })
  }

  it.each(AGENT_SHELL)('refuses an approval in a shell started for an agent (%s)', async (variable) => {
    const card = await createWaitingCard()
    const before = await readChangeSeq(store)
    vi.stubEnv(variable, variable === 'KANBO_ACTOR_KIND' ? 'agent' : 'session-1')

    await expect(run(['approve', card.id])).rejects.toThrowError(refusalOf(describeApprovalRefusal, ['approve', card.id]))

    expect((await store.issues.findById(card.id))?.waitingFor).toBe('human')
    expect(await store.comments.listByIssue(card.id)).toHaveLength(0)
    expect(await readChangeSeq(store)).toBe(before)
  })

  it.each(AGENT_TOOL_MARKS)('refuses an approval in a shell an agent tool marked (%s=%s), naming the mark', async (variable, value, label) => {
    const card = await createWaitingCard()
    vi.stubEnv(variable, value)

    const message = describeApprovalRefusal(label, ['kanbo', ...typed(['approve', card.id])].join(' '))
    await expect(run(['approve', card.id])).rejects.toThrowError(expect.objectContaining({ exitCode: 4, message }))
    const [refused, override] = message.split('\n')
    expect(refused).toBe(`Only a person can approve a card. This shell belongs to an agent (${label}): ask a person to approve it on the board page (kanbo serve).`)
    expect(override).toBe(`If you are a person in an editor terminal, run: KANBO_ACTOR_KIND=person kanbo approve ${card.id} --db ${board.path} --workspace ${WORKSPACE.id}`)
    expect((await store.issues.findById(card.id))?.waitingFor).toBe('human')
  })

  it('lets a person approve in their own terminal that carries a mark, with KANBO_ACTOR_KIND=person', async () => {
    const card = await createWaitingCard()
    vi.stubEnv('CLAUDECODE', '1')
    vi.stubEnv('KANBO_ACTOR_KIND', 'person')

    await run(['approve', card.id])

    expect((await store.issues.findById(card.id))?.waitingFor).toBeNull()
  })

  it('lets a person approve in their own terminal that Codex marked, with KANBO_ACTOR_KIND=person', async () => {
    const card = await createWaitingCard()
    vi.stubEnv('CODEX_THREAD_ID', '019a0000-0000-7000-8000-000000000000')
    vi.stubEnv('KANBO_ACTOR_KIND', 'person')

    await run(['approve', card.id])

    expect((await store.issues.findById(card.id))?.waitingFor).toBeNull()
  })

  it('reads CLAUDECODE only as documented: 1, not any value', async () => {
    const card = await createWaitingCard()
    vi.stubEnv('CLAUDECODE', '0')

    await run(['approve', card.id])

    expect((await store.issues.findById(card.id))?.waitingFor).toBeNull()
  })

  it('refuses a return in the same shell, and says so about returning', async () => {
    const card = await createWaitingCard()
    vi.stubEnv('KANBO_ACTOR_KIND', 'agent')

    const refusal = expect.objectContaining({
      exitCode: 4,
      message: describeReturnRefusal('KANBO_ACTOR_KIND=agent', ['kanbo', 'return', card.id, '--comment', '\'not yet\'', ...typed([])].join(' ')),
    })
    await expect(run(['return', card.id, '--comment', 'not yet'])).rejects.toThrowError(refusal)
    await expect(run(['return', card.id, '--comment', 'it\'s not'])).rejects.toThrowError(expect.objectContaining({
      message: expect.stringContaining(`KANBO_ACTOR_KIND=person kanbo return ${card.id} --comment 'it'\\''s not' --db`),
    }))
    expect((await store.issues.findById(card.id))?.waitingFor).toBe('human')
  })

  it('goes through in a person\'s own terminal', async () => {
    const card = await createWaitingCard()

    await run(['approve', card.id, '--comment', 'looks right'])

    expect((await store.issues.findById(card.id))?.waitingFor).toBeNull()
    const [comment] = await store.comments.listByIssue(card.id)
    expect(comment.authorKind).toBe('system.approved')
    expect(comment.content).toBe('Approved\nlooks right')
  })

  /** A sprint with one unfinished card, and the sprint after it. */
  async function createSprints() {
    const current = await createMilestone(store, { workspaceId: WORKSPACE.id, title: 'Sprint 1', startDate: 1, dueDate: 2 })
    const next = await createMilestone(store, { workspaceId: WORKSPACE.id, title: 'Sprint 2', startDate: 3, dueDate: 4 })
    const card = await createCard(store, { workspace: WORKSPACE, title: 'Card', milestoneId: current.id }, AGENT)
    return { current, next, card }
  }

  it.each(AGENT_SHELL)('refuses closing a sprint in a shell started for an agent (%s)', async (variable) => {
    const { current, next, card } = await createSprints()
    const before = await readChangeSeq(store)
    vi.stubEnv(variable, variable === 'KANBO_ACTOR_KIND' ? 'agent' : 'session-1')

    const argv = ['sprint', 'close', current.id, '--carry-to', next.id]
    await expect(run(argv)).rejects.toThrowError(refusalOf(describeSprintCloseRefusal, argv))

    expect((await store.milestones.findById(current.id))?.status).toBe('open')
    expect((await store.issues.findById(card.id))?.milestoneId).toBe(current.id)
    expect(await readChangeSeq(store)).toBe(before)
  })

  it('closes a sprint in a person\'s own terminal, carrying the unfinished card on as the person', async () => {
    const { current, next, card } = await createSprints()

    await run(['sprint', 'close', current.id, '--carry-to', next.id])

    expect((await store.milestones.findById(current.id))?.status).toBe('closed')
    expect((await store.issues.findById(card.id))?.milestoneId).toBe(next.id)
    const [change] = await store.fieldChanges.listByIssueField(card.id, 'milestoneId')
    expect(change).toMatchObject({ actorKind: 'user', fromValue: current.id, toValue: next.id })
  })

  it('refuses closing a sprint of another workspace on the same board, by its id', async () => {
    seedHostWorkspace(board, 'other', 'OTH')
    const theirs = await createMilestone(store, { workspaceId: 'other', title: 'Their sprint', startDate: 1, dueDate: 2 })

    await expect(run(['sprint', 'close', theirs.id])).rejects.toThrowError(expect.objectContaining({ message: expect.stringContaining('issue_milestone_not_found') }))
    expect((await store.milestones.findById(theirs.id))?.status).toBe('open')
  })
  /** A run that named the wrong log of its own. */
  async function createRunWithRef() {
    const card = await createCard(store, { workspace: WORKSPACE, title: 'Card' }, AGENT)
    return await startRun(store, card.id, { agentName: 'Codex', externalSessionRef: 'codex:wrong' }, AGENT)
  }

  it.each(AGENT_SHELL)('refuses clearing or replacing a run\'s log in a shell started for an agent (%s)', async (variable) => {
    const started = await createRunWithRef()
    const before = await readChangeSeq(store)
    vi.stubEnv(variable, variable === 'KANBO_ACTOR_KIND' ? 'agent' : 'session-1')

    const clear = ['run', 'clear-session', started.id]
    const replace = ['run', 'attach-session', started.id, 'claude:right', '--replace']
    await expect(run(clear)).rejects.toThrowError(refusalOf(describeRunSessionRefRefusal, clear))
    await expect(run(replace)).rejects.toThrowError(refusalOf(describeRunSessionRefRefusal, replace))

    expect((await store.runs.findById(started.id))?.externalSessionRef).toBe('codex:wrong')
    expect(await readChangeSeq(store)).toBe(before)
  })

  it('replaces and clears a run\'s log in a person\'s own terminal', async () => {
    const started = await createRunWithRef()

    await run(['run', 'attach-session', started.id, 'claude:right', '--replace'])
    expect((await store.runs.findById(started.id))?.externalSessionRef).toBe('claude:right')

    await run(['run', 'clear-session', started.id])
    expect((await store.runs.findById(started.id))?.externalSessionRef).toBeNull()
  })
})

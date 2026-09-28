import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { BoardStore } from '../board-store'

/**
 * One store to run the scenarios against, with the rows every board needs
 * around it: two empty workspaces, because cards, columns and milestones all
 * point at one and half the scenarios are about a workspace not seeing the
 * other's rows.
 */
export interface BoardStoreContractHarness {
  store: BoardStore
  workspaceId: string
  secondWorkspaceId: string
  /**
   * Throw the board away. Called after every scenario, so none of them share
   * rows. A board that is a file closes a handle; a board that is a database
   * hangs up, which takes a promise.
   */
  dispose: () => void | Promise<void>
}

/**
 * Scenarios every `BoardStore` implementation must satisfy.
 *
 * `makeStore` owns everything implementation-specific — opening the board,
 * seeding the two workspaces, throwing it away again — so the scenarios below
 * name nothing but the store interface. Each implementation calls this from a
 * test file of its own with its own factory, which is why the scenarios live
 * here, beside the test databases, rather than inside either of those files:
 * the file that names an engine must not drag the other engine's run along
 * with it.
 */
export function runBoardStoreContract(name: string, makeStore: () => Promise<BoardStoreContractHarness>): void {
  describe(name, () => {
    let harness: BoardStoreContractHarness | undefined
    let store: BoardStore
    let workspaceId: string
    let secondWorkspaceId: string

    beforeEach(async () => {
      harness = await makeStore()
      store = harness.store
      workspaceId = harness.workspaceId
      secondWorkspaceId = harness.secondWorkspaceId
    })

    afterEach(async () => {
      // A factory that threw leaves nothing to throw away, and the failure it
      // threw is the one worth reading.
      await harness?.dispose()
      harness = undefined
    })

    /** A card, with only the columns a scenario cares about spelled out. */
    async function createIssue(values: { id: string, number: number, title?: string, workspaceId?: string, createdAt?: number }) {
      return await store.issues.create({
        workspaceId,
        title: values.title ?? values.id,
        ...values,
      })
    }

    describe('statuses', () => {
      it('creates statuses with categories and finds them by id and workspace', async () => {
        const triage = await store.statuses.create({
          id: 'status-triage',
          workspaceId,
          name: 'Triage',
          category: 'triage',
        })
        const done = await store.statuses.create({
          id: 'status-done',
          workspaceId,
          name: 'Done',
          category: 'completed',
        })

        expect(triage).toEqual(expect.objectContaining({ name: 'Triage', category: 'triage', workspaceId }))
        expect(await store.statuses.findById(triage.id)).toEqual(triage)
        expect(await store.statuses.findInWorkspace(workspaceId, done.id)).toEqual(done)
        expect(await store.statuses.findInWorkspace(secondWorkspaceId, done.id)).toBeNull()
        expect(await store.statuses.countByWorkspace(workspaceId)).toBe(2)
        expect(await store.statuses.countByWorkspace(secondWorkspaceId)).toBe(0)
      })

      it('keeps a column\'s entry rules as written, and none on a column without them', async () => {
        const plain = await store.statuses.create({ id: 'status-plain', workspaceId, name: 'Plain' })
        expect(plain.entryRules).toBeNull()

        const ruled = await store.statuses.create({
          id: 'status-ruled',
          workspaceId,
          name: 'Review',
          entryRules: '["pull_request_linked","ci_green"]',
        })
        expect(ruled.entryRules).toBe('["pull_request_linked","ci_green"]')

        await store.statuses.update(ruled.id, { entryRules: '["approved"]' })
        expect((await store.statuses.findById(ruled.id))?.entryRules).toBe('["approved"]')
        await store.statuses.update(ruled.id, { entryRules: null })
        expect((await store.statuses.findById(ruled.id))?.entryRules).toBeNull()
      })

      it('lists a workspace\'s statuses in board order, not insertion order', async () => {
        const second = await store.statuses.create({ id: 'status-b', workspaceId, name: 'Second', category: 'unstarted', order: 1 })
        const first = await store.statuses.create({ id: 'status-a', workspaceId, name: 'First', category: 'backlog', order: 0 })
        const third = await store.statuses.create({ id: 'status-c', workspaceId, name: 'Third', category: 'started', order: 2 })

        expect((await store.statuses.listByWorkspace(workspaceId)).map(status => status.id)).toEqual([first.id, second.id, third.id])
      })

      it('lists every workspace\'s statuses, in board order within each workspace', async () => {
        await store.statuses.create({ id: 'a-second', workspaceId, name: 'Second', order: 1 })
        await store.statuses.create({ id: 'a-first', workspaceId, name: 'First', order: 0 })
        await store.statuses.create({ id: 'b-second', workspaceId: secondWorkspaceId, name: 'Second', order: 1 })
        await store.statuses.create({ id: 'b-first', workspaceId: secondWorkspaceId, name: 'First', order: 0 })

        const inBoardOrder = await store.statuses.listAllInBoardOrder()
        expect(inBoardOrder.filter(status => status.workspaceId === workspaceId).map(status => status.id))
          .toEqual(['a-first', 'a-second'])
        expect(inBoardOrder.filter(status => status.workspaceId === secondWorkspaceId).map(status => status.id))
          .toEqual(['b-first', 'b-second'])

        expect((await store.statuses.listAll()).map(status => status.id).sort())
          .toEqual(['a-first', 'a-second', 'b-first', 'b-second'])
      })
    })

    describe('issues', () => {
      it('numbers issues per workspace, and a second workspace starts its own sequence', async () => {
        expect(await store.issues.maxNumber(workspaceId)).toBe(0)

        const first = await createIssue({ id: 'issue-1', number: (await store.issues.maxNumber(workspaceId)) + 1, title: 'First issue' })
        const second = await createIssue({ id: 'issue-2', number: (await store.issues.maxNumber(workspaceId)) + 1, title: 'Second issue' })
        expect([first.number, second.number]).toEqual([1, 2])
        expect(await store.issues.maxNumber(workspaceId)).toBe(2)

        expect(await store.issues.maxNumber(secondWorkspaceId)).toBe(0)
        const otherFirst = await createIssue({
          id: 'other-issue-1',
          workspaceId: secondWorkspaceId,
          number: (await store.issues.maxNumber(secondWorkspaceId)) + 1,
          title: 'Other workspace issue',
        })
        expect(otherFirst.number).toBe(1)
        // The first workspace's sequence is unaffected by the second workspace's insert.
        expect(await store.issues.maxNumber(workspaceId)).toBe(2)
      })

      it('reorders issues by updating their order field', async () => {
        const a = await store.issues.create({ id: 'issue-a', workspaceId, number: 1, title: 'A', order: 0 })
        const b = await store.issues.create({ id: 'issue-b', workspaceId, number: 2, title: 'B', order: 1 })
        const c = await store.issues.create({ id: 'issue-c', workspaceId, number: 3, title: 'C', order: 2 })
        expect((await store.issues.listInBoardOrder(workspaceId)).map(issue => issue.id)).toEqual([a.id, b.id, c.id])

        await store.issues.update(c.id, { order: -1 })

        expect((await store.issues.listInBoardOrder(workspaceId)).map(issue => issue.id)).toEqual([c.id, a.id, b.id])
      })

      it('breaks board-order ties by id, so pages of tied cards neither skip nor repeat one', async () => {
        // Forty cards never dragged and made in the same millisecond tie on
        // both board-order keys. Written, and numbered, out of id order, so a
        // read that fell back on how the engine happened to store or index them
        // would show it.
        const ids = Array.from({ length: 40 }, (_, index) => `issue-${String(index).padStart(2, '0')}`)
        const written = ids.map((id, index) => ({ id, spread: ((index + 1) * 17) % 41 })).sort((a, b) => a.spread - b.spread)
        for (const [index, { id }] of written.entries()) {
          await store.issues.create({ id, number: index + 1, workspaceId, title: id, order: 0, createdAt: 1_000, updatedAt: 1_000 })
        }

        const unpaged = (await store.issues.listPage({ workspaceId })).cards.map(card => card.id)
        expect(unpaged).toEqual(ids)
        expect((await store.issues.listInBoardOrder(workspaceId)).map(card => card.id)).toEqual(ids)

        const paged: string[] = []
        for (let offset = 0; offset < ids.length; offset += 3) {
          paged.push(...(await store.issues.listPage({ workspaceId, offset, limit: 3 })).cards.map(card => card.id))
        }
        expect(paged).toEqual(unpaged)
      })

      it('finds text ignoring case beyond ASCII, and keeps like wildcards literal', async () => {
        await createIssue({ id: 'issue-umlaut', number: 1, title: 'Über die Brücke' })
        await store.issues.create({ id: 'issue-body', workspaceId, number: 2, title: 'Plain', description: 'ÉCOLE Straße' })
        await createIssue({ id: 'issue-wild', number: 3, title: '50% off_now' })
        const found = async (text: string) => (await store.issues.listPage({ workspaceId, text })).cards.map(card => card.id)

        expect(await found('über')).toEqual(['issue-umlaut'])
        expect(await found('ÜBER')).toEqual(['issue-umlaut'])
        expect(await found('brÜcke')).toEqual(['issue-umlaut'])
        expect(await found('école')).toEqual(['issue-body'])
        expect(await found('STRASSE')).toEqual([])
        expect(await found('ISSUE-UMLAUT')).toEqual(['issue-umlaut'])
        expect(await found('0%')).toEqual(['issue-wild'])
        expect(await found('f_n')).toEqual(['issue-wild'])
        expect(await found('f_x')).toEqual([])
      })

      it('updates issue fields', async () => {
        const issue = await createIssue({ id: 'issue-1', number: 1, title: 'Original title' })

        await store.issues.update(issue.id, { title: 'Updated title', description: 'Updated body', priority: 'urgent' })

        expect(await store.issues.findById(issue.id)).toEqual(expect.objectContaining({
          title: 'Updated title',
          description: 'Updated body',
          priority: 'urgent',
        }))
      })

      it('applies one patch to many issues, and reports how many rows it wrote', async () => {
        const a = await createIssue({ id: 'issue-a', number: 1 })
        const b = await createIssue({ id: 'issue-b', number: 2 })
        const untouched = await createIssue({ id: 'issue-c', number: 3 })

        const written = await store.issues.updateMany([a.id, b.id], { priority: 'high', updatedAt: 4_242 })

        expect(written).toBe(2)
        expect((await store.issues.findById(a.id))).toEqual(expect.objectContaining({ priority: 'high', updatedAt: 4_242 }))
        expect((await store.issues.findById(b.id))).toEqual(expect.objectContaining({ priority: 'high', updatedAt: 4_242 }))
        expect((await store.issues.findById(untouched.id))?.priority).toBe('none')
      })

      it('writes nothing, and says so, when the patch names no issue at all', async () => {
        // The bulk update a host reaches this with is free to arrive with an
        // empty selection — `updateMany` is called straight from one — and
        // both engines have to answer `0` without touching a row, however each
        // of them arrives at that.
        const untouched = await createIssue({ id: 'issue-a', number: 1 })

        expect(await store.issues.updateMany([], { priority: 'high', updatedAt: 4_242 })).toBe(0)

        expect(await store.issues.findById(untouched.id))
          .toEqual(expect.objectContaining({ priority: 'none', updatedAt: untouched.updatedAt }))
      })

      it('reads issues by a list of ids, and leaves out the ids it has no row for', async () => {
        const a = await createIssue({ id: 'issue-a', number: 1 })
        const b = await createIssue({ id: 'issue-b', number: 2 })
        await createIssue({ id: 'issue-c', number: 3 })

        const found = await store.issues.listByIds([a.id, 'issue-that-was-never-written', b.id])

        expect(found.map(issue => issue.id).sort()).toEqual([a.id, b.id])
      })

      it('finds an issue by the number it carries inside its own workspace', async () => {
        const mine = await createIssue({ id: 'issue-1', number: 1 })
        const theirs = await createIssue({ id: 'other-issue-1', workspaceId: secondWorkspaceId, number: 1 })

        expect(await store.issues.findByNumber(workspaceId, 1)).toEqual(mine)
        expect(await store.issues.findByNumber(secondWorkspaceId, 1)).toEqual(theirs)
        expect(await store.issues.findByNumber(workspaceId, 2)).toBeNull()
      })

      it('lists every issue newest first, across workspaces', async () => {
        await createIssue({ id: 'issue-old', number: 1, createdAt: 1_000 })
        await createIssue({ id: 'issue-new', workspaceId: secondWorkspaceId, number: 1, createdAt: 3_000 })
        await createIssue({ id: 'issue-middle', number: 2, createdAt: 2_000 })

        expect((await store.issues.listNewestFirst()).map(issue => issue.id))
          .toEqual(['issue-new', 'issue-middle', 'issue-old'])
      })

      it('detaches every child when parent references are cleared', async () => {
        const parent = await createIssue({ id: 'issue-parent', number: 1 })
        const child = await store.issues.create({ id: 'issue-child', workspaceId, number: 2, title: 'Child', parentIssueId: parent.id })
        const unrelated = await createIssue({ id: 'issue-unrelated', number: 3 })

        await store.issues.clearParentReferences(parent.id, 5_000)

        expect(await store.issues.findById(child.id)).toEqual(expect.objectContaining({ parentIssueId: null, updatedAt: 5_000 }))
        expect((await store.issues.findById(unrelated.id))?.updatedAt).not.toBe(5_000)
      })

      it('undelegates every card that named a deleted agent or provider target', async () => {
        // Both columns are soft references — the rows behind them belong to
        // whatever app is looking at this board, and no board file is
        // obliged to hold them (ruling 5-1) — so nothing here fires when one of
        // them goes. This is what the host calls instead.
        const delegated = await store.issues.create({
          id: 'issue-delegated',
          workspaceId,
          number: 1,
          title: 'Delegated',
          delegateAgentId: 'agent-1',
          delegateProviderTargetId: 'target-1',
        })
        const elsewhere = await store.issues.create({
          id: 'issue-elsewhere',
          workspaceId,
          number: 2,
          title: 'Delegated to another agent',
          delegateAgentId: 'agent-2',
          delegateProviderTargetId: 'target-2',
        })

        expect(await store.issues.clearDelegateReferences({ agentId: 'agent-1' }, 7_000)).toBe(1)

        // Half a delegation is not a state the board is ever left in: a card
        // whose agent is gone has no target either.
        expect(await store.issues.findById(delegated.id)).toEqual(expect.objectContaining({
          delegateAgentId: null,
          delegateProviderTargetId: null,
          updatedAt: 7_000,
        }))
        expect(await store.issues.findById(elsewhere.id)).toEqual(expect.objectContaining({
          delegateAgentId: 'agent-2',
          delegateProviderTargetId: 'target-2',
        }))

        expect(await store.issues.clearDelegateReferences({ providerTargetId: 'target-2' }, 8_000)).toBe(1)
        expect(await store.issues.findById(elsewhere.id)).toEqual(expect.objectContaining({
          delegateAgentId: null,
          delegateProviderTargetId: null,
          updatedAt: 8_000,
        }))

        // And a name no card carries writes nothing at all.
        expect(await store.issues.clearDelegateReferences({ agentId: 'agent-nobody' }, 9_000)).toBe(0)
      })

      it('deletes an issue', async () => {
        const issue = await createIssue({ id: 'issue-1', number: 1, title: 'Temporary' })

        await store.issues.delete(issue.id)

        expect(await store.issues.findById(issue.id)).toBeNull()
      })
    })

    describe('milestones', () => {
      it('creates and updates a milestone', async () => {
        const milestone = await store.milestones.create({ id: 'milestone-1', workspaceId, title: 'Launch' })
        expect(milestone).toEqual(expect.objectContaining({ title: 'Launch', workspaceId, status: 'open' }))

        await store.milestones.update(milestone.id, { title: 'Launch v2', status: 'closed' })

        expect(await store.milestones.findById(milestone.id)).toEqual(expect.objectContaining({ title: 'Launch v2', status: 'closed' }))
      })

      it('keeps a sprint start date as written, and a plain milestone without one', async () => {
        const plain = await store.milestones.create({ id: 'milestone-plain', workspaceId, title: 'Plain' })
        expect(plain.startDate).toBeNull()

        const sprint = await store.milestones.create({
          id: 'milestone-sprint',
          workspaceId,
          title: 'Sprint 1',
          startDate: 1_767_225_600,
          dueDate: 1_768_435_200,
        })
        expect(sprint).toEqual(expect.objectContaining({ startDate: 1_767_225_600, dueDate: 1_768_435_200 }))

        await store.milestones.update(sprint.id, { startDate: 1_767_312_000 })
        expect((await store.milestones.findById(sprint.id))?.startDate).toBe(1_767_312_000)
        await store.milestones.update(sprint.id, { startDate: null })
        expect((await store.milestones.findById(sprint.id))?.startDate).toBeNull()
      })

      it('lists milestones newest first, of one workspace or of every one', async () => {
        await store.milestones.create({ id: 'milestone-old', workspaceId, title: 'Old', createdAt: 1_000 })
        await store.milestones.create({ id: 'milestone-new', workspaceId, title: 'New', createdAt: 3_000 })
        await store.milestones.create({ id: 'milestone-other', workspaceId: secondWorkspaceId, title: 'Other', createdAt: 2_000 })

        expect((await store.milestones.listNewestFirst(workspaceId)).map(milestone => milestone.id))
          .toEqual(['milestone-new', 'milestone-old'])
        expect((await store.milestones.listNewestFirst(null)).map(milestone => milestone.id))
          .toEqual(['milestone-new', 'milestone-other', 'milestone-old'])
      })

      it('finds a milestone only through the workspace it belongs to', async () => {
        const milestone = await store.milestones.create({ id: 'milestone-1', workspaceId, title: 'Launch' })

        expect(await store.milestones.findInWorkspace(workspaceId, milestone.id)).toEqual(milestone)
        expect(await store.milestones.findInWorkspace(secondWorkspaceId, milestone.id)).toBeNull()
      })

      it('detaches the issues that point at a milestone before it is deleted', async () => {
        const milestone = await store.milestones.create({ id: 'milestone-1', workspaceId, title: 'Launch' })
        const issue = await store.issues.create({
          id: 'issue-1',
          workspaceId,
          number: 1,
          title: 'Tracked issue',
          milestoneId: milestone.id,
        })
        expect((await store.issues.findById(issue.id))?.milestoneId).toBe(milestone.id)

        // What the caller deleting a milestone does, in the order it does it: the
        // references are cleared through the store, not left to a constraint the
        // next implementation may not declare.
        await store.issues.clearMilestoneReferences(milestone.id, 6_000)
        await store.milestones.delete(milestone.id)

        expect(await store.milestones.findById(milestone.id)).toBeNull()
        expect(await store.issues.findById(issue.id)).toEqual(expect.objectContaining({ milestoneId: null, updatedAt: 6_000 }))
      })
    })

    describe('comments', () => {
      it('adds, lists in creation order, and deletes comments on an issue', async () => {
        const issue = await createIssue({ id: 'issue-1', number: 1, title: 'Commented issue' })

        const first = await store.comments.create({ id: 'comment-1', issueId: issue.id, content: 'First', createdAt: 1_000 })
        const second = await store.comments.create({ id: 'comment-2', issueId: issue.id, content: 'Second', createdAt: 1_001 })

        expect((await store.comments.listByIssue(issue.id)).map(comment => comment.id)).toEqual([first.id, second.id])

        await store.comments.delete(first.id)

        expect(await store.comments.findById(first.id)).toBeNull()
        expect((await store.comments.listByIssue(issue.id)).map(comment => comment.id)).toEqual([second.id])
      })

      it('writes a keyed comment once, and hands back the standing row every time after', async () => {
        const issue = await createIssue({ id: 'issue-1', number: 1 })
        const other = await createIssue({ id: 'issue-2', number: 2 })

        const written = await store.comments.createOnce({
          id: 'comment-1',
          issueId: issue.id,
          content: 'Run finished',
          dedupeKey: 'run-1-finished',
        })
        const again = await store.comments.createOnce({
          id: 'comment-2',
          issueId: issue.id,
          content: 'Run finished, said twice',
          dedupeKey: 'run-1-finished',
        })

        expect(again).toEqual(written)
        expect((await store.comments.listByIssue(issue.id)).map(comment => comment.content)).toEqual(['Run finished'])

        // The key is unique per issue, so the same key on another card is another comment.
        const elsewhere = await store.comments.createOnce({
          id: 'comment-3',
          issueId: other.id,
          content: 'Run finished',
          dedupeKey: 'run-1-finished',
        })
        expect(elsewhere.id).toBe('comment-3')
      })

      it('finds the comment a card carries under a dedupe key, and nothing under a key it does not', async () => {
        const issue = await createIssue({ id: 'issue-1', number: 1 })
        const other = await createIssue({ id: 'issue-2', number: 2 })
        const written = await store.comments.createOnce({
          id: 'comment-1',
          issueId: issue.id,
          content: 'PR #7 merged',
          dedupeKey: 'pr-merged:acme/app#7',
        })

        expect(await store.comments.findByDedupeKey(issue.id, 'pr-merged:acme/app#7')).toEqual(written)
        expect(await store.comments.findByDedupeKey(issue.id, 'pr-closed:acme/app#7')).toBeNull()
        // The key belongs to the card that carries it.
        expect(await store.comments.findByDedupeKey(other.id, 'pr-merged:acme/app#7')).toBeNull()
      })

      it('lists the comments whose dedupe key starts with a prefix, oldest first, reading no character as a wildcard', async () => {
        const issue = await createIssue({ id: 'issue-1', number: 1 })
        const other = await createIssue({ id: 'issue-2', number: 2 })
        const key = (id: string, dedupeKey: string, createdAt: number) => store.comments.createOnce({ id, issueId: issue.id, content: id, dedupeKey, createdAt })
        const first = await key('comment-1', 'ci:my_org/app#7@aaa:red', 1_000)
        const second = await key('comment-2', 'ci:my_org/app#7@bbb:green', 1_000)
        await key('comment-3', 'ci:my_org/app#70@ccc:green', 1_000)
        await key('comment-4', 'ci:myXorg/app#7@ddd:green', 1_000)
        await store.comments.create({ id: 'comment-5', issueId: issue.id, content: 'no key' })
        await store.comments.createOnce({ id: 'comment-6', issueId: other.id, content: 'elsewhere', dedupeKey: 'ci:my_org/app#7@eee:green' })

        expect(await store.comments.listByDedupeKeyPrefix(issue.id, 'ci:my_org/app#7@')).toEqual([first, second])
        expect(await store.comments.listByDedupeKeyPrefix(issue.id, 'pr-merged:')).toEqual([])
      })
    })

    describe('runs', () => {
      it('records a run, finds it by id, and counts it among the issue\'s runs', async () => {
        const issue = await createIssue({ id: 'issue-1', number: 1 })

        const run = await store.runs.create({ id: 'run-1', issueId: issue.id, agentName: 'Claude', startedAt: 1_000 })

        expect(run).toEqual(expect.objectContaining({
          issueId: issue.id,
          agentName: 'Claude',
          state: 'running',
          launchedByKind: 'user',
          executionMode: 'worktree',
          endedAt: null,
          externalSessionRef: null,
        }))
        expect(await store.runs.findById(run.id)).toEqual(run)
        expect(await store.runs.findById('run-that-was-never-written')).toBeNull()
        expect(await store.runs.countByIssue(issue.id)).toBe(1)
      })

      it('keeps a run\'s external session ref as written, round-tripping through create and update', async () => {
        const issue = await createIssue({ id: 'issue-1', number: 1 })

        const withRef = await store.runs.create({
          id: 'run-1',
          issueId: issue.id,
          agentName: 'Claude',
          startedAt: 1_000,
          externalSessionRef: 'claude:abc-123',
        })
        expect(withRef.externalSessionRef).toBe('claude:abc-123')
        expect((await store.runs.findById(withRef.id))?.externalSessionRef).toBe('claude:abc-123')

        await store.runs.update(withRef.id, { externalSessionRef: 'codex:def-456' })
        expect((await store.runs.findById(withRef.id))?.externalSessionRef).toBe('codex:def-456')

        await store.runs.update(withRef.id, { externalSessionRef: null })
        expect((await store.runs.findById(withRef.id))?.externalSessionRef).toBeNull()
      })

      it('lists the runs of an issue oldest first, in insertion order within one second', async () => {
        const issue = await createIssue({ id: 'issue-1', number: 1 })
        const other = await createIssue({ id: 'issue-2', number: 2 })
        await store.runs.create({ id: 'run-second', issueId: issue.id, agentName: 'Claude', startedAt: 2_000 })
        await store.runs.create({ id: 'run-first', issueId: issue.id, agentName: 'Claude', startedAt: 1_000 })
        // Same second as the run before it: insertion order is what separates them.
        await store.runs.create({ id: 'run-third', issueId: issue.id, agentName: 'Codex', startedAt: 2_000 })
        await store.runs.create({ id: 'run-elsewhere', issueId: other.id, agentName: 'Codex', startedAt: 1_500 })

        expect((await store.runs.listByIssue(issue.id)).map(run => run.id))
          .toEqual(['run-first', 'run-second', 'run-third'])
      })

      it('ends a run, and lists only the ones still running', async () => {
        const issue = await createIssue({ id: 'issue-1', number: 1 })
        const ended = await store.runs.create({ id: 'run-1', issueId: issue.id, agentName: 'Claude', startedAt: 1_000 })
        const running = await store.runs.create({ id: 'run-2', issueId: issue.id, agentName: 'Codex', startedAt: 2_000 })

        await store.runs.update(ended.id, { state: 'finished', endedAt: 1_500, branch: 'feat/board' })

        expect(await store.runs.findById(ended.id)).toEqual(expect.objectContaining({
          state: 'finished',
          endedAt: 1_500,
          branch: 'feat/board',
        }))
        expect((await store.runs.listRunning(issue.id)).map(run => run.id)).toEqual([running.id])
        expect(await store.runs.countByIssue(issue.id)).toBe(2)
      })

      it('lists every still running run a chat session drives, across workspaces and oldest first', async () => {
        const issue = await createIssue({ id: 'issue-1', number: 1 })
        // The one run listing with no scope at all: a host coming back up asks
        // about its own runs, not about a board.
        const other = await createIssue({ id: 'issue-2', number: 1, workspaceId: secondWorkspaceId })
        await store.runs.create({ id: 'run-launched', issueId: issue.id, agentName: 'Claude', chatSessionId: 'session-1', startedAt: 1_000 })
        await store.runs.create({ id: 'run-launched-elsewhere', issueId: other.id, agentName: 'Codex', chatSessionId: 'session-2', startedAt: 2_000 })
        // Launched from outside: no chat session drives it.
        await store.runs.create({ id: 'run-outside', issueId: issue.id, agentName: 'Claude', startedAt: 1_500 })
        const ended = await store.runs.create({ id: 'run-ended', issueId: issue.id, agentName: 'Claude', chatSessionId: 'session-3', startedAt: 500 })
        await store.runs.update(ended.id, { state: 'finished', endedAt: 900 })

        expect((await store.runs.listRunningWithSession()).map(run => run.id))
          .toEqual(['run-launched', 'run-launched-elsewhere'])
      })

      it('finds the newest run driving a chat session, across issues', async () => {
        const issue = await createIssue({ id: 'issue-1', number: 1 })
        const other = await createIssue({ id: 'issue-2', number: 2 })
        await store.runs.create({ id: 'run-old', issueId: issue.id, agentName: 'Claude', chatSessionId: 'session-1', startedAt: 1_000 })
        await store.runs.create({ id: 'run-new', issueId: other.id, agentName: 'Claude', chatSessionId: 'session-1', startedAt: 2_000 })

        expect((await store.runs.findByChatSessionId('session-1'))?.id).toBe('run-new')
        expect(await store.runs.findByChatSessionId('session-nobody-drives')).toBeNull()
      })

      it('projects the attempt count and the active run of every card in scope', async () => {
        const launchedTwice = await createIssue({ id: 'issue-1', number: 1 })
        const launchedOnce = await createIssue({ id: 'issue-2', number: 2 })
        const neverLaunched = await createIssue({ id: 'issue-3', number: 3 })
        const firstAttempt = await store.runs.create({ id: 'run-1', issueId: launchedTwice.id, agentName: 'Claude', startedAt: 1_000 })
        await store.runs.update(firstAttempt.id, { state: 'failed', endedAt: 1_500 })
        await store.runs.create({ id: 'run-2', issueId: launchedTwice.id, agentName: 'Codex', startedAt: 2_000 })
        const doneRun = await store.runs.create({ id: 'run-3', issueId: launchedOnce.id, agentName: 'Claude', startedAt: 1_000 })
        await store.runs.update(doneRun.id, { state: 'finished', endedAt: 1_200 })

        const projection = await store.runs.project({ workspaceId })

        expect(projection.find(card => card.issueId === launchedTwice.id)).toEqual({
          issueId: launchedTwice.id,
          attemptCount: 2,
          activeRun: expect.objectContaining({ id: 'run-2', agentName: 'Codex', state: 'running', startedAt: 2_000 }),
        })
        expect(projection.find(card => card.issueId === launchedOnce.id)).toEqual({
          issueId: launchedOnce.id,
          attemptCount: 1,
          activeRun: null,
        })
        // A card that has never been launched is simply absent.
        expect(projection.find(card => card.issueId === neverLaunched.id)).toBeUndefined()

        expect(await store.runs.project({ issueIds: [launchedOnce.id] }))
          .toEqual([{ issueId: launchedOnce.id, attemptCount: 1, activeRun: null }])
        expect(await store.runs.project({ issueIds: [] })).toEqual([])
      })
    })

    describe('relations', () => {
      it('creates blocks/duplicates/relates_to edges, found from either issue', async () => {
        const a = await createIssue({ id: 'issue-a', number: 1, title: 'A' })
        const b = await createIssue({ id: 'issue-b', number: 2, title: 'B' })

        const blocks = await store.relations.create({ id: 'relation-blocks', sourceIssueId: a.id, targetIssueId: b.id, type: 'blocks' })
        const duplicates = await store.relations.create({ id: 'relation-duplicates', sourceIssueId: a.id, targetIssueId: b.id, type: 'duplicates' })
        const relatesTo = await store.relations.create({ id: 'relation-relates', sourceIssueId: a.id, targetIssueId: b.id, type: 'relates_to' })

        const expectedIds = [blocks.id, duplicates.id, relatesTo.id].sort()
        expect((await store.relations.listByIssue(a.id)).map(relation => relation.id).sort()).toEqual(expectedIds)
        expect((await store.relations.listByIssue(b.id)).map(relation => relation.id).sort()).toEqual(expectedIds)
      })

      it('matches directional edges only in their declared direction, but relates_to symmetrically', async () => {
        const a = await createIssue({ id: 'issue-a', number: 1, title: 'A' })
        const b = await createIssue({ id: 'issue-b', number: 2, title: 'B' })
        const blocks = await store.relations.create({ id: 'relation-blocks', sourceIssueId: a.id, targetIssueId: b.id, type: 'blocks' })
        const relatesTo = await store.relations.create({ id: 'relation-relates', sourceIssueId: a.id, targetIssueId: b.id, type: 'relates_to' })

        expect(await store.relations.findMatching({ sourceIssueId: a.id, targetIssueId: b.id, type: 'blocks' })).toEqual(blocks)
        expect(await store.relations.findMatching({ sourceIssueId: b.id, targetIssueId: a.id, type: 'blocks' })).toBeNull()

        // relates_to is undirected: the reversed pair matches the same row.
        expect(await store.relations.findMatching({ sourceIssueId: b.id, targetIssueId: a.id, type: 'relates_to' })).toEqual(relatesTo)
      })

      it('deletes a relation', async () => {
        const a = await createIssue({ id: 'issue-a', number: 1, title: 'A' })
        const b = await createIssue({ id: 'issue-b', number: 2, title: 'B' })
        const relation = await store.relations.create({ id: 'relation-1', sourceIssueId: a.id, targetIssueId: b.id, type: 'blocks' })

        await store.relations.delete(relation.id)

        expect(await store.relations.findById(relation.id)).toBeNull()
      })

      it('drops every edge touching an issue, in either direction', async () => {
        const a = await createIssue({ id: 'issue-a', number: 1, title: 'A' })
        const b = await createIssue({ id: 'issue-b', number: 2, title: 'B' })
        const c = await createIssue({ id: 'issue-c', number: 3, title: 'C' })
        await store.relations.create({ id: 'relation-out', sourceIssueId: a.id, targetIssueId: b.id, type: 'blocks' })
        await store.relations.create({ id: 'relation-in', sourceIssueId: c.id, targetIssueId: a.id, type: 'blocks' })
        await store.relations.create({ id: 'relation-elsewhere', sourceIssueId: b.id, targetIssueId: c.id, type: 'relates_to' })

        await store.relations.deleteByIssue(a.id)

        expect(await store.relations.listByIssue(a.id)).toEqual([])
        expect((await store.relations.listByIssue(b.id)).map(relation => relation.id)).toEqual(['relation-elsewhere'])
      })
    })

    describe('context refs', () => {
      it('replaces the whole ref list of one issue', async () => {
        const issue = await createIssue({ id: 'issue-1', number: 1 })
        const other = await createIssue({ id: 'issue-2', number: 2 })
        expect(issue.contextRefs).toBe('[]')

        const refs = JSON.stringify([{ kind: 'file', path: 'src/board-store.ts' }])
        await store.contextRefs.replace(issue.id, refs, 7_000)

        expect(await store.issues.findById(issue.id)).toEqual(expect.objectContaining({ contextRefs: refs, updatedAt: 7_000 }))
        expect((await store.issues.findById(other.id))?.contextRefs).toBe('[]')
      })
    })

    describe('field changes', () => {
      it('records field changes and lists them oldest first', async () => {
        const issue = await createIssue({ id: 'issue-1', number: 1 })
        const other = await createIssue({ id: 'issue-2', number: 2 })

        await store.fieldChanges.create({
          id: 'change-second',
          issueId: issue.id,
          field: 'title',
          fromValue: 'Before',
          toValue: 'After',
          actorKind: 'agent',
          actorId: 'agent-1',
          createdAt: 2_000,
        })
        await store.fieldChanges.create({
          id: 'change-first',
          issueId: issue.id,
          field: 'statusLine',
          fromValue: null,
          toValue: 'writing the migration',
          createdAt: 1_000,
        })
        await store.fieldChanges.create({ id: 'change-elsewhere', issueId: other.id, field: 'title', createdAt: 1_500 })

        const changes = await store.fieldChanges.listByIssue(issue.id)
        expect(changes.map(change => change.id)).toEqual(['change-first', 'change-second'])
        expect(changes[1]).toEqual(expect.objectContaining({
          field: 'title',
          fromValue: 'Before',
          toValue: 'After',
          actorKind: 'agent',
          actorId: 'agent-1',
        }))
      })

      it('lists the changes of one field only', async () => {
        const issue = await createIssue({ id: 'issue-1', number: 1 })
        await store.fieldChanges.create({ id: 'change-line-1', issueId: issue.id, field: 'statusLine', toValue: 'first', createdAt: 1_000 })
        await store.fieldChanges.create({ id: 'change-title', issueId: issue.id, field: 'title', toValue: 'Renamed', createdAt: 2_000 })
        await store.fieldChanges.create({ id: 'change-line-2', issueId: issue.id, field: 'statusLine', toValue: 'second', createdAt: 3_000 })

        expect((await store.fieldChanges.listByIssueField(issue.id, 'statusLine')).map(change => change.id))
          .toEqual(['change-line-1', 'change-line-2'])
        expect(await store.fieldChanges.listByIssueField(issue.id, 'priority')).toEqual([])
      })
    })

    describe('history within one second', () => {
      it('keeps same-second comments and field changes in the order they were written', async () => {
        const issue = await createIssue({ id: 'issue-1', number: 1 })

        // `created_at` counts whole seconds, so two decisions a person and an
        // agent make inside the same one carry the same stamp. The board still
        // has to hand them back in the order it wrote them: `readApproval`
        // takes the *last* comment to decide whether a card was approved or
        // returned, so a tie the board resolves by guessing is a card that
        // reads differently depending on which engine holds it. The ids are
        // deliberately written out of alphabetical order, so an ordering that
        // falls back on the id — which is a random UUID in production — fails
        // here instead of passing by accident.
        await store.comments.create({ id: 'comment-z-returned', issueId: issue.id, content: 'Back to you', authorKind: 'system.returned', createdAt: 1_000 })
        await store.comments.create({ id: 'comment-a-approved', issueId: issue.id, content: 'Go ahead', authorKind: 'system.approved', createdAt: 1_000 })

        await store.fieldChanges.create({ id: 'change-z-first', issueId: issue.id, field: 'statusLine', toValue: 'first', createdAt: 1_000 })
        await store.fieldChanges.create({ id: 'change-a-second', issueId: issue.id, field: 'statusLine', toValue: 'second', createdAt: 1_000 })

        expect((await store.comments.listByIssue(issue.id)).map(comment => comment.id))
          .toEqual(['comment-z-returned', 'comment-a-approved'])
        expect((await store.fieldChanges.listByIssue(issue.id)).map(change => change.id))
          .toEqual(['change-z-first', 'change-a-second'])
        expect((await store.fieldChanges.listByIssueField(issue.id, 'statusLine')).map(change => change.id))
          .toEqual(['change-z-first', 'change-a-second'])
      })
    })

    describe('pull requests', () => {
      /** A link, with only what a scenario cares about spelled out. */
      function prLink(values: { id: string, issueId: string, number: number, repo?: string, createdAt?: number }) {
        const repo = values.repo ?? 'repo'
        return {
          owner: 'octo',
          repo,
          url: `https://github.com/octo/${repo}/pull/${values.number}`,
          createdByKind: 'agent' as const,
          createdById: 'agent-1',
          ...values,
        }
      }

      it('links a pull request once, and hands back the standing link every time after', async () => {
        const issue = await createIssue({ id: 'issue-1', number: 1 })

        const linked = await store.pullRequests.link(prLink({ id: 'pr-1', issueId: issue.id, number: 7 }))
        const again = await store.pullRequests.link(prLink({ id: 'pr-2', issueId: issue.id, number: 7 }))

        expect(linked).toEqual(expect.objectContaining({
          id: 'pr-1',
          issueId: issue.id,
          owner: 'octo',
          repo: 'repo',
          number: 7,
          url: 'https://github.com/octo/repo/pull/7',
          createdByKind: 'agent',
          createdById: 'agent-1',
        }))
        expect(again).toEqual(linked)
        expect(await store.pullRequests.listByIssue(issue.id)).toEqual([linked])
      })

      it('lets another card name the same pull request, and keeps each card\'s links to itself', async () => {
        const issue = await createIssue({ id: 'issue-1', number: 1 })
        const other = await createIssue({ id: 'issue-2', number: 2 })

        await store.pullRequests.link(prLink({ id: 'pr-1', issueId: issue.id, number: 7 }))
        const elsewhere = await store.pullRequests.link(prLink({ id: 'pr-2', issueId: other.id, number: 7 }))

        expect(elsewhere.id).toBe('pr-2')
        expect((await store.pullRequests.listByIssue(issue.id)).map(link => link.id)).toEqual(['pr-1'])
        expect((await store.pullRequests.listByIssue(other.id)).map(link => link.id)).toEqual(['pr-2'])
      })

      it('lists a card\'s links in the order they were made, within one second too', async () => {
        const issue = await createIssue({ id: 'issue-1', number: 1 })

        // Out of alphabetical order on purpose, as the history scenario does.
        await store.pullRequests.link(prLink({ id: 'pr-z', issueId: issue.id, number: 9, createdAt: 1_000 }))
        await store.pullRequests.link(prLink({ id: 'pr-a', issueId: issue.id, number: 3, createdAt: 1_000 }))
        await store.pullRequests.link(prLink({ id: 'pr-m', issueId: issue.id, number: 5, createdAt: 1_001 }))

        expect((await store.pullRequests.listByIssue(issue.id)).map(link => link.id)).toEqual(['pr-z', 'pr-a', 'pr-m'])
      })

      it('lists every link on the board with its card\'s workspace, across workspaces', async () => {
        const issue = await createIssue({ id: 'issue-1', number: 1 })
        const other = await createIssue({ id: 'issue-2', number: 1, workspaceId: secondWorkspaceId })

        await store.pullRequests.link(prLink({ id: 'pr-1', issueId: issue.id, number: 7, createdAt: 1_000 }))
        await store.pullRequests.link(prLink({ id: 'pr-2', issueId: other.id, number: 8, repo: 'other', createdAt: 1_001 }))

        const linked = await store.pullRequests.listLinked()
        expect(linked.map(link => [link.id, link.issueId, link.workspaceId, `${link.owner}/${link.repo}#${link.number}`])).toEqual([
          ['pr-1', issue.id, workspaceId, 'octo/repo#7'],
          ['pr-2', other.id, secondWorkspaceId, 'octo/other#8'],
        ])
        // The storage's own ordering column never leaves the store.
        expect(Object.keys(linked[0]).sort()).toEqual([
          'createdAt',
          'createdById',
          'createdByKind',
          'id',
          'issueId',
          'number',
          'owner',
          'repo',
          'url',
          'workspaceId',
        ])
      })

      it('unlinks only through the card that names the link', async () => {
        const issue = await createIssue({ id: 'issue-1', number: 1 })
        const other = await createIssue({ id: 'issue-2', number: 2 })
        const linked = await store.pullRequests.link(prLink({ id: 'pr-1', issueId: issue.id, number: 7 }))

        expect(await store.pullRequests.unlink(other.id, linked.id)).toBeNull()
        expect(await store.pullRequests.listByIssue(issue.id)).toHaveLength(1)

        expect(await store.pullRequests.unlink(issue.id, linked.id)).toEqual(linked)
        expect(await store.pullRequests.listByIssue(issue.id)).toEqual([])
        expect(await store.pullRequests.unlink(issue.id, linked.id)).toBeNull()
      })

      it('takes a card\'s links with it when the card is deleted', async () => {
        const issue = await createIssue({ id: 'issue-1', number: 1 })
        await store.pullRequests.link(prLink({ id: 'pr-1', issueId: issue.id, number: 7 }))

        await store.issues.delete(issue.id)

        expect(await store.pullRequests.listLinked()).toEqual([])
      })
    })

    describe('meta', () => {
      it('raises a counter by one, creating it at 1 when it is not there yet', async () => {
        expect(await store.meta.read('contract-counter')).toBeNull()

        await store.meta.bumpRevision('contract-counter', 8_000)
        expect(await store.meta.read('contract-counter')).toEqual(expect.objectContaining({ revision: 1, updatedAt: 8_000 }))

        await store.meta.bumpRevision('contract-counter', 9_000)
        expect(await store.meta.read('contract-counter')).toEqual(expect.objectContaining({ revision: 2, updatedAt: 9_000 }))
      })
    })

    describe('transactions', () => {
      it('rolls back every write when the callback throws', async () => {
        await expect(store.transaction(async (tx) => {
          await tx.issues.create({ id: 'issue-rollback', workspaceId, number: 1, title: 'Should not persist' })
          throw new Error('forced rollback')
        })).rejects.toThrow('forced rollback')

        expect(await store.issues.findById('issue-rollback')).toBeNull()
      })

      it('rolls back only the inner writes when a nested transaction throws', async () => {
        await store.transaction(async (tx) => {
          await tx.issues.create({ id: 'issue-outer', workspaceId, number: 1, title: 'Outer commit' })

          await expect(tx.transaction(async (innerTx) => {
            await innerTx.issues.create({ id: 'issue-inner', workspaceId, number: 2, title: 'Inner rollback' })
            throw new Error('forced inner rollback')
          })).rejects.toThrow('forced inner rollback')
        })

        expect(await store.issues.findById('issue-outer')).not.toBeNull()
        expect(await store.issues.findById('issue-inner')).toBeNull()
      })
    })
  })
}

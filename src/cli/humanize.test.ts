import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BoardErrorCode } from '../domain/errors'
import { BoardError } from '../domain/errors'
import { BOARD_ERROR_RESPONSES } from '../serve/board-error-responses'
import { describeFailure } from './failure'
import { BOARD_ERROR_TEXTS } from './humanize'

/** Every code the board names: `BOARD_ERROR_RESPONSES` is a `Record` over the whole union. */
const EVERY_CODE = Object.keys(BOARD_ERROR_RESPONSES) as BoardErrorCode[]

/** What each failure prints, from the details the board throws it with. */
const EXPECTED: Record<BoardErrorCode, [Record<string, unknown>, string]> = {
  board_approval_requires_user: [{ issueId: 'MYA-1', actorKind: 'agent' }, 'Only a person can approve a card.\n  Next: run it in your own terminal, or on the board page (kanbo serve)'],
  board_column_name_taken: [{ name: 'done', takenBy: 'Done' }, 'Another column, Done, already has that name (same slug). Pick another name.\n  Next: kanbo columns list'],
  board_column_not_empty: [{ statusName: 'In Review', cardCount: 2 }, 'In Review holds 2 cards. Say where they go.\n  Next: kanbo columns remove in_review --move-cards-to <column>'],
  board_column_ready_protected: [{ statusName: 'To Do' }, 'To Do can\'t be removed: kanbo ready takes work from To Do, and agents would find no cards to take.'],
  board_column_remove_target_invalid: [{ statusName: 'QA' }, 'Cards can\'t move into QA: it is the column being removed.\n  Next: kanbo columns list'],
  board_column_rules_requires_user: [{ actorKind: 'agent' }, 'Only a person can set what a column asks of a card.\n  Next: run it in your own terminal, or on the board page (kanbo serve)'],
  board_column_rules_unmet: [
    { issueId: 'MYA-1', column: 'Done', unmet: [{ rule: 'ci_green', detail: 'no CI result yet' }] },
    'MYA-1 can\'t go into "Done" yet:\n- ci_green: no CI result yet\n  Next: fix what is listed, or ask a person to move the card',
  ],
  board_column_structure_requires_user: [{ actorKind: 'agent' }, 'Only a person can change the board\'s columns.\n  Next: run it in your own terminal, or on the board page (kanbo serve)'],
  board_entry_rule_invalid: [{ rules: ['green'], allowed: ['ci_green', 'approved'] }, 'Unknown column rule: green. Use any of ci_green, approved.'],
  board_execution_mode_locked: [{ issueId: 'MYA-1', executionMode: 'worktree' }, 'MYA-1 has been started, so where it is worked (worktree) can\'t change now.'],
  board_pull_request_invalid: [{ value: 'nope' }, '"nope" is not a GitHub pull request. Give its link or owner/repo#number.'],
  board_pull_request_not_found: [{ issueId: 'MYA-1', linkId: 'l1' }, 'MYA-1 has no pull request link "l1".\n  Next: kanbo card pr list MYA-1'],
  board_pull_request_not_yours: [{ issueId: 'MYA-1', linkId: 'l1' }, 'Someone else linked that pull request to MYA-1; only they or a person can unlink it.'],
  board_return_no_previous_column: [{ issueId: 'MYA-1' }, 'MYA-1 is already in the first column: there is no column before it to send it back to.\n  Next: kanbo return MYA-1 --to <column>'],
  board_return_requires_user: [{ issueId: 'MYA-1' }, 'Only a person can send a card back.\n  Next: run it in your own terminal, or on the board page (kanbo serve)'],
  board_run_already_finished: [{ runId: 'r1', state: 'finished' }, 'Run r1 has already finished.'],
  board_run_not_found: [{ runId: 'r1' }, 'No run "r1" on this board.'],
  board_run_session_ref_conflict: [
    { runId: 'r1', externalSessionRef: { provider: 'claude', id: 'abc' } },
    'Run r1 already names another session log (claude:abc).\n  Next: a person can replace it: kanbo run attach-session r1 <ref> --replace',
  ],
  board_run_session_ref_invalid: [{ value: 'x' }, '"x" is not a session log. Give it as claude:<id> or codex:<id>.'],
  board_run_session_ref_requires_user: [{ runId: 'r1' }, 'Only a person can change or clear the session log a run names.\n  Next: run it in your own terminal, or on the board page (kanbo serve)'],
  board_schema_outdated: [{ expected: 3, found: 2 }, 'This board was made by an older kanbo.\n  Next: kanbo migrate'],
  board_sprint_carry_invalid: [{ carryTo: 'm9' }, 'Unfinished cards can only move on to another open sprint of this board, and "m9" is not one.\n  Next: kanbo sprint list'],
  board_sprint_close_requires_user: [{ milestoneId: 'm1' }, 'Only a person can close a sprint.\n  Next: run it in your own terminal, or on the board page (kanbo serve)'],
  board_sprint_dates_invalid: [{ startDate: 2, dueDate: 1 }, 'A sprint can\'t start after it is due.'],
  issue_comment_delete_requires_user: [{ commentId: 'c1' }, 'Only a person can delete a comment the board wrote itself.\n  Next: run it in your own terminal, or on the board page (kanbo serve)'],
  issue_comment_not_found: [{ commentId: 'c1' }, 'No comment "c1" on this board.'],
  issue_context_ref_invalid_index: [{ issueId: 'MYA-1', index: 4 }, 'MYA-1 has no context link number 4.\n  Next: kanbo card get MYA-1'],
  issue_milestone_not_found: [{ milestoneId: 'm1' }, 'No sprint "m1" on this board.\n  Next: kanbo sprint list'],
  issue_not_found: [{ issueId: 'MYA-9' }, 'No card "MYA-9" here.\n  Next: kanbo card list'],
  issue_parent_cycle: [{ issueId: 'MYA-1', parentIssueId: 'MYA-2' }, 'A card can\'t be put under one of its own sub-cards.'],
  issue_parent_not_found: [{ parentIssueId: 'MYA-9' }, 'No card "MYA-9" here to put this one under.\n  Next: kanbo card list'],
  issue_parent_self_reference: [{ issueId: 'MYA-1' }, 'A card can\'t be put under itself.'],
  issue_relation_not_found: [{ relationId: 'x1' }, 'No link "x1" between cards on this board.'],
  issue_relation_self_reference: [{ issueId: 'MYA-1' }, 'A card can\'t be linked to itself.'],
  issue_status_name_empty: [{}, 'Give the column a name.'],
  issue_status_not_found: [{ statusName: 'foo' }, 'No column "foo" on this board.\n  Next: kanbo columns list'],
  issue_status_reference_conflict: [{}, 'Name the column once: by its id or by its name, not both.'],
  issue_workspace_not_found: [{ workspaceId: 'w1' }, 'No project "w1" on this board.\n  Next: run kanbo in the project folder'],
}

describe('board failures in plain words', () => {
  beforeEach(() => {
    vi.stubEnv('KANBO_DEBUG', '')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('has words for every code the board names, so a new one cannot slip through', () => {
    expect(EVERY_CODE.filter(code => typeof BOARD_ERROR_TEXTS[code] !== 'function')).toEqual([])
    expect(Object.keys(BOARD_ERROR_TEXTS).sort()).toEqual([...EVERY_CODE].sort())
    expect(Object.keys(EXPECTED).sort()).toEqual([...EVERY_CODE].sort())
  })

  it.each(EVERY_CODE)('%s', (code) => {
    const [details, said] = EXPECTED[code]
    const message = describeFailure(new BoardError(code, details)).message
    const lines = said.split('\n')
    const last = lines.pop()!
    expect(message).toBe([...lines, `${last}  [${code}]`].join('\n'))
    expect(message).not.toContain('{')
  })

  it('names what To Do cannot be renamed to', () => {
    expect(describeFailure(new BoardError('board_column_ready_protected', { statusName: 'To Do', newName: 'Ready' })).message)
      .toBe('To Do can\'t be renamed to "Ready": kanbo ready takes work from To Do, and agents would find no cards to take. '
        + 'Another spelling of To Do (To-do, TO DO) is fine.  [board_column_ready_protected]')
  })
})

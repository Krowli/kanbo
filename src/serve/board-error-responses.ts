import type { BoardErrorCode } from '../domain/errors'

/** What one board failure is over HTTP: the status, the sentence, and the code a client matches on when it is renamed. */
export interface BoardErrorResponse {
  status: number
  message: string
  code?: string
}

/**
 * What each board failure becomes over HTTP.
 *
 * The board names its failures and nothing else (`../domain/errors.ts`); the
 * status code and the sentence a client reads are decided here, once, for both
 * edges that serve it over HTTP — `kanbo serve` and any app that serves the
 * same routes — so a client written against one reads the other's failures the
 * same way. The
 * table is exhaustive on purpose — a new code in the package fails to compile
 * until this module says what it means to a caller — and it follows one rule: something the caller asked for that is not
 * there is 404, something the caller asked for that cannot be done is 400,
 * answering for a person — approving a card, sending it back or closing a
 * sprint — as anyone but one is 403, dropping a pull request link somebody else made is the same 403
 * for the same reason, and acting on a run that has already ended is 409,
 * because the answer would have been yes a moment earlier. An agent putting a
 * card in a column whose entry rules it does not meet yet is 409 for the same
 * reason turned around: the answer will be yes once the card meets them, and
 * `details.unmet` says what is missing.
 *
 * The five failures about where a board is kept read the same rule. A database
 * that holds no board this build can speak for is 409 — the setting is there,
 * the board behind it is not yet, and `board-storage prepare` is what settles
 * that — and one nobody could reach at all is 503, because nothing about the
 * request was wrong. A workspace naming no board at all is 404: the caller
 * asked about a setting that is not there. A board still holding cards when
 * somebody asks to point the workspace elsewhere is 409, because the answer
 * would have been yes on an empty board and `board-storage migrate` is what
 * makes it one. An operation naming cards from two different boards is 400: no
 * transaction reaches both, so the caller asked for something that cannot be
 * done. A copy that would land on a card number or a column name the target
 * already holds under a different id is 409 for the same reason the others
 * are: the answer would have been yes on a target that did not hold that
 * board, and `details.conflicts` names every value that clashed.
 *
 * A failure may also be renamed here: the package names its codes after the
 * board, while every error the `/issues` routes answer with is named after the
 * issue, and a client matching on `issue_*` should not have to learn a second
 * spelling. The code carries through unchanged when no `code` is given.
 */
export const BOARD_ERROR_RESPONSES: Record<BoardErrorCode, BoardErrorResponse> = {
  board_approval_requires_user: { status: 403, message: 'Only a person can approve a card', code: 'issue_approval_requires_user' },
  board_column_rules_requires_user: { status: 403, message: 'Only a person can set what a column asks of a card', code: 'issue_column_rules_requires_user' },
  board_column_rules_unmet: { status: 409, message: 'The card does not meet what that column asks for yet', code: 'issue_column_rules_unmet' },
  board_copy_conflict: { status: 409, message: 'That board already holds cards or columns of this workspace under the same numbers or names; nothing was copied' },
  board_entry_rule_invalid: { status: 400, message: 'Unknown column entry rule' },
  board_execution_mode_locked: { status: 400, message: 'Execution mode cannot change once the card has been launched' },
  board_mixed_workspaces: { status: 400, message: 'Those cards are not all on the same board' },
  board_pull_request_invalid: { status: 400, message: 'Not a GitHub pull request: give its URL or owner/repo#number' },
  board_pull_request_not_found: { status: 404, message: 'The card names no such pull request' },
  board_pull_request_not_yours: { status: 403, message: 'You did not link that pull request', code: 'issue_pull_request_not_yours' },
  board_return_no_previous_column: { status: 400, message: 'The card is already in the first column' },
  board_return_requires_user: { status: 403, message: 'Only a person can send a card back', code: 'issue_return_requires_user' },
  board_run_already_finished: { status: 409, message: 'Run has already finished' },
  board_run_not_found: { status: 404, message: 'Run not found' },
  board_run_session_ref_conflict: { status: 409, message: 'The run already names a different log of its own' },
  board_run_session_ref_invalid: { status: 400, message: 'Not an external session reference: give claude:<id> or codex:<id>' },
  board_run_session_ref_requires_user: { status: 403, message: 'Only a person can change or clear the log a run names' },
  board_schema_outdated: { status: 400, message: 'Board schema is outdated' },
  board_sprint_carry_invalid: { status: 400, message: 'Unfinished cards can only be carried to another open milestone of the same workspace' },
  board_sprint_close_requires_user: { status: 403, message: 'Only a person can close a sprint', code: 'issue_sprint_close_requires_user' },
  board_sprint_dates_invalid: { status: 400, message: 'A sprint cannot start after it is due' },
  board_storage_not_configured: { status: 404, message: 'This workspace names no board storage' },
  board_storage_not_empty: { status: 409, message: 'That board still holds cards of this workspace; move them with migrate before changing where the board is kept' },
  board_storage_not_prepared: { status: 409, message: 'That board has not been prepared yet' },
  board_storage_unavailable: { status: 503, message: 'That board could not be reached' },
  issue_comment_delete_requires_user: { status: 403, message: 'Only a person can delete a comment the board wrote' },
  issue_comment_not_found: { status: 404, message: 'Comment not found' },
  issue_context_ref_invalid_index: { status: 400, message: 'Invalid context ref index' },
  issue_milestone_not_found: { status: 404, message: 'Milestone not found' },
  issue_not_found: { status: 404, message: 'Issue not found' },
  issue_parent_not_found: { status: 404, message: 'Parent issue not found' },
  issue_parent_self_reference: { status: 400, message: 'Issue cannot be its own parent' },
  issue_relation_not_found: { status: 404, message: 'Relation not found' },
  issue_relation_self_reference: { status: 400, message: 'An issue cannot be related to itself' },
  issue_status_name_empty: { status: 400, message: 'Status name must not be empty' },
  issue_status_not_found: { status: 404, message: 'Status not found' },
  issue_status_reference_conflict: { status: 400, message: 'Use either statusId or statusName, not both' },
  issue_workspace_not_found: { status: 404, message: 'Workspace not found' },
}

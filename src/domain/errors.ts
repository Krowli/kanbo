/**
 * Every failure the board itself can name. HTTP status codes are not part of
 * this list: what each code is over HTTP is `BOARD_ERROR_RESPONSES`
 * (`../serve/board-error-responses.ts`), the one table `kanbo serve` and any app
 * serving the board over HTTP answer with.
 */
export type BoardErrorCode
  = | 'board_approval_requires_user'
    | 'board_column_name_taken'
    | 'board_column_not_empty'
    | 'board_column_ready_protected'
    | 'board_column_remove_target_invalid'
    | 'board_column_rules_requires_user'
    | 'board_column_structure_requires_user'
    | 'board_column_rules_unmet'
    | 'board_entry_rule_invalid'
    | 'board_execution_mode_locked'
    | 'board_pull_request_invalid'
    | 'board_pull_request_not_found'
    | 'board_pull_request_not_yours'
    | 'board_return_no_previous_column'
    | 'board_return_requires_user'
    | 'board_run_already_finished'
    | 'board_run_not_found'
    | 'board_run_session_ref_conflict'
    | 'board_run_session_ref_invalid'
    | 'board_run_session_ref_requires_user'
    | 'board_schema_outdated'
    | 'board_sprint_carry_invalid'
    | 'board_sprint_close_requires_user'
    | 'board_sprint_dates_invalid'
    | 'issue_comment_delete_requires_user'
    | 'issue_comment_not_found'
    | 'issue_context_ref_invalid_index'
    | 'issue_milestone_not_found'
    | 'issue_not_found'
    | 'issue_parent_not_found'
    | 'issue_parent_self_reference'
    | 'issue_relation_not_found'
    | 'issue_relation_self_reference'
    | 'issue_status_name_empty'
    | 'issue_status_not_found'
    | 'issue_status_reference_conflict'
    | 'issue_workspace_not_found'

/** A board rule the caller broke, carrying the offending values in `details`. */
export class BoardError extends Error {
  readonly code: BoardErrorCode
  readonly details?: Record<string, unknown>

  constructor(code: BoardErrorCode, details?: Record<string, unknown>) {
    super(code)
    this.code = code
    this.details = details
  }
}

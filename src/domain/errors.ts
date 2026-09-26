/**
 * Every failure the board itself can name. HTTP status codes are not part of
 * this list: what each code is over HTTP is `BOARD_ERROR_RESPONSES`
 * (`../serve/board-error-responses.ts`), the one table `kanbo serve` and any app
 * serving the board over HTTP answer with.
 *
 * Five of them are about where a board lives rather than about what is on it,
 * and they are named here for the same reason as the rest: a host that keeps
 * one board in a file and another in a database still answers its callers in
 * one vocabulary. `board_storage_not_prepared` is a connection string pointing
 * at a database that holds no board this build can speak for,
 * `board_storage_unavailable` is one the host could not reach at all,
 * `board_storage_not_configured` is a workspace that names no board to look at,
 * `board_storage_not_empty` is a board still holding cards when something asked
 * to point the workspace somewhere else, and `board_mixed_workspaces` is a
 * single operation naming cards that turned out to live in two different
 * boards — which no transaction can commit as one.
 */
export type BoardErrorCode
  = | 'board_approval_requires_user'
    | 'board_column_rules_requires_user'
    | 'board_column_rules_unmet'
    | 'board_copy_conflict'
    | 'board_entry_rule_invalid'
    | 'board_execution_mode_locked'
    | 'board_mixed_workspaces'
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
    | 'board_storage_not_configured'
    | 'board_storage_not_empty'
    | 'board_storage_not_prepared'
    | 'board_storage_unavailable'
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

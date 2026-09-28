import type { ColumnRefusalDetails } from '../domain/entry-rules'
import type { BoardErrorCode } from '../domain/errors'
import { normalizeStatusName } from '../domain/status-name'

/**
 * What the command line says about each rule of the board a command broke.
 *
 * A `BoardError` names its failure with a code and carries the values that
 * caused it in `details`. A person reads neither: they read one sentence that
 * says what went wrong in the board's own words, and — when there is one — the
 * command that gets them further. The code still follows the sentence
 * (`failure.ts`), so a person can search for it and a script can match on it.
 *
 * The table is a `Record` over every code on purpose: a new code does not
 * compile until it says something here.
 */
export interface HumanizedFailure {
  /** What went wrong, in a sentence or two. */
  text: string
  /** The command (or the step) that gets a person further, when there is one. */
  next?: string
}

type Details = Record<string, unknown>

/** Where a person answers for themselves: never an agent's shell. */
const AS_A_PERSON = 'run it in your own terminal, or on the board page (kanbo serve)'

export const BOARD_ERROR_TEXTS: Record<BoardErrorCode, (details: Details) => HumanizedFailure> = {
  board_approval_requires_user: () => ({ text: 'Only a person can approve a card.', next: AS_A_PERSON }),
  board_column_name_taken: details => ({
    text: `Another column, ${named(details.takenBy)}, already has that name (same slug). Pick another name.`,
    next: 'kanbo columns list',
  }),
  board_column_not_empty: details => ({
    text: `${named(details.statusName)} holds ${describeCount(Number(details.cardCount))}. Say where they go.`,
    next: `kanbo columns remove ${normalizeStatusName(named(details.statusName))} --move-cards-to <column>`,
  }),
  board_column_ready_protected: details => ({
    text: details.newName === undefined
      ? `${named(details.statusName)} can't be removed: kanbo ready takes work from To Do, and agents would find no cards to take.`
      : `${named(details.statusName)} can't be renamed to "${named(details.newName)}": kanbo ready takes work from To Do, `
        + 'and agents would find no cards to take. Another spelling of To Do (To-do, TO DO) is fine.',
  }),
  board_column_remove_target_invalid: details => ({
    text: `Cards can't move into ${named(details.statusName)}: it is the column being removed.`,
    next: 'kanbo columns list',
  }),
  board_column_rules_requires_user: () => ({ text: 'Only a person can set what a column asks of a card.', next: AS_A_PERSON }),
  board_column_rules_unmet: (details) => {
    const refusal = details as unknown as ColumnRefusalDetails
    const card = refusal.issueId ? `${refusal.issueId} can't go into` : 'A new card can\'t be created in'
    return {
      text: [
        `${card} "${refusal.column}" yet:`,
        ...refusal.unmet.map(item => `- ${item.rule}: ${item.detail}`),
      ].join('\n'),
      next: 'fix what is listed, or ask a person to move the card',
    }
  },
  board_column_structure_requires_user: () => ({ text: 'Only a person can change the board\'s columns.', next: AS_A_PERSON }),
  board_entry_rule_invalid: details => ({
    text: `Unknown column rule: ${list(details.rules)}. Use any of ${list(details.allowed)}.`,
  }),
  board_execution_mode_locked: details => ({
    text: `${named(details.issueId)} has been started, so where it is worked (${named(details.executionMode)}) can't change now.`,
  }),
  board_pull_request_invalid: details => ({
    text: `"${named(details.value)}" is not a GitHub pull request. Give its link or owner/repo#number.`,
  }),
  board_pull_request_not_found: details => ({
    text: `${named(details.issueId)} has no pull request link "${named(details.linkId)}".`,
    next: `kanbo card pr list ${named(details.issueId)}`,
  }),
  board_pull_request_not_yours: details => ({
    text: `Someone else linked that pull request to ${named(details.issueId)}; only they or a person can unlink it.`,
  }),
  board_return_no_previous_column: details => ({
    text: `${named(details.issueId)} is already in the first column: there is no column before it to send it back to.`,
    next: `kanbo return ${named(details.issueId)} --to <column>`,
  }),
  board_return_requires_user: () => ({ text: 'Only a person can send a card back.', next: AS_A_PERSON }),
  board_run_already_finished: details => ({ text: `Run ${named(details.runId)} has already finished.` }),
  board_run_not_found: details => ({ text: `No run "${named(details.runId)}" on this board.` }),
  board_run_session_ref_conflict: details => ({
    text: `Run ${named(details.runId)} already names another session log (${describeSessionRef(details.externalSessionRef)}).`,
    next: `a person can replace it: kanbo run attach-session ${named(details.runId)} <ref> --replace`,
  }),
  board_run_session_ref_invalid: details => ({
    text: `"${named(details.value)}" is not a session log. Give it as claude:<id> or codex:<id>.`,
  }),
  board_run_session_ref_requires_user: () => ({
    text: 'Only a person can change or clear the session log a run names.',
    next: AS_A_PERSON,
  }),
  board_schema_outdated: () => ({ text: 'This board was made by an older kanbo.', next: 'kanbo migrate' }),
  board_sprint_carry_invalid: details => ({
    text: `Unfinished cards can only move on to another open sprint of this board, and "${named(details.carryTo)}" is not one.`,
    next: 'kanbo sprint list',
  }),
  board_sprint_close_requires_user: () => ({ text: 'Only a person can close a sprint.', next: AS_A_PERSON }),
  board_sprint_dates_invalid: () => ({ text: 'A sprint can\'t start after it is due.' }),
  issue_comment_delete_requires_user: () => ({
    text: 'Only a person can delete a comment the board wrote itself.',
    next: AS_A_PERSON,
  }),
  issue_comment_not_found: details => ({ text: `No comment "${named(details.commentId)}" on this board.` }),
  issue_context_ref_invalid_index: details => ({
    text: `${named(details.issueId)} has no context link number ${named(details.index)}.`,
    next: `kanbo card get ${named(details.issueId)}`,
  }),
  issue_milestone_not_found: details => ({
    text: `No sprint "${named(details.milestoneId)}" on this board.`,
    next: 'kanbo sprint list',
  }),
  issue_not_found: details => ({ text: `No card "${named(details.issueId)}" here.`, next: 'kanbo card list' }),
  issue_parent_cycle: () => ({ text: 'A card can\'t be put under one of its own sub-cards.' }),
  issue_parent_not_found: details => ({
    text: `No card "${named(details.parentIssueId)}" here to put this one under.`,
    next: 'kanbo card list',
  }),
  issue_parent_self_reference: () => ({ text: 'A card can\'t be put under itself.' }),
  issue_relation_not_found: details => ({ text: `No link "${named(details.relationId)}" between cards on this board.` }),
  issue_relation_self_reference: () => ({ text: 'A card can\'t be linked to itself.' }),
  issue_status_name_empty: () => ({ text: 'Give the column a name.' }),
  issue_status_not_found: details => ({
    text: `No column "${named(details.statusName ?? details.statusId)}" on this board.`,
    next: 'kanbo columns list',
  }),
  issue_status_reference_conflict: () => ({ text: 'Name the column once: by its id or by its name, not both.' }),
  issue_workspace_not_found: details => ({
    text: `No project "${named(details.workspaceId)}" on this board.`,
    next: 'run kanbo in the project folder',
  }),
}

/** What to say about a board failure, from its code and the values that caused it. */
export function humanizeBoardError(code: BoardErrorCode, details: Details | undefined): HumanizedFailure | null {
  const describe = BOARD_ERROR_TEXTS[code] as ((details: Details) => HumanizedFailure) | undefined
  return describe ? describe(details ?? {}) : null
}

function named(value: unknown): string {
  return value === undefined || value === null ? '?' : String(value)
}

function list(value: unknown): string {
  return Array.isArray(value) ? value.join(', ') : named(value)
}

function describeCount(count: number): string {
  return `${count} ${count === 1 ? 'card' : 'cards'}`
}

function describeSessionRef(value: unknown): string {
  if (typeof value === 'object' && value !== null && 'provider' in value && 'id' in value) {
    return `${String(value.provider)}:${String(value.id)}`
  }
  return named(value)
}

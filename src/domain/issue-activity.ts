import type { IssueComment } from '../sqlite/schema'
import type {
  IssueActivityCommentView,
  IssueActivityItemView,
  IssueActivityLookup,
  IssueActivityValueToken,
  IssueActivityValueView,
} from './activity-types'
import type { IssueActorReference, IssueWriterProvenance } from './issue-view'
import { isOutsideWriter, normalizeCommentAuthorKind } from './issue-view'

export function activityKindOrder(kind: IssueActivityItemView['kind']): number {
  if (kind === 'created') {
    return 0
  }
  if (kind === 'field-change') {
    return 1
  }
  return 2
}

/**
 * The badge a system comment renders under. Delegation owns two of its own; the
 * rest of the `system.*` markers read as plain system comments until they earn
 * a badge.
 *
 * A plain `system` row is where provenance decides: a writer from outside —
 * the command line, an agent someone ran themselves — is stored as `system` too, and what it wrote is an ordinary comment
 * rather than a line about the board — `isOutsideWriter` is that question.
 */
export function readSystemCommentKind(
  authorKind: IssueComment['authorKind'],
  provenance: IssueWriterProvenance,
): IssueActivityCommentView['systemKind'] {
  if (authorKind === 'system.delegated') {
    return 'delegated'
  }
  if (authorKind === 'system.undelegated') {
    return 'undelegated'
  }
  if (authorKind === 'user' || authorKind === 'agent' || authorKind === 'provider-target') {
    return null
  }
  if (authorKind === 'system' && isOutsideWriter(provenance)) {
    return null
  }
  return 'system'
}

/**
 * Who a comment is shown under. A `system.*` marker is the board's own line
 * about what happened — a run launched, a person's decision — so the id it
 * carries names whoever caused the line, never its author. Only a plain
 * `system` row can name a writer.
 */
export function commentAuthorReference(comment: IssueComment): IssueActorReference {
  const kind = normalizeCommentAuthorKind(comment.authorKind)
  const isBoardMarker = kind === 'system' && comment.authorKind !== 'system'
  return {
    kind,
    id: isBoardMarker ? null : comment.authorId,
    sourceChatSessionId: comment.sourceChatSessionId,
  }
}

export function formatActivityIssueReference(value: string | null, lookup: IssueActivityLookup): IssueActivityValueView {
  if (!value) {
    return activityToken('no-parent')
  }
  const issue = lookup.issueById.get(value)
  if (!issue) {
    return activityToken('unknown-issue')
  }
  return { kind: 'text', text: `${issue.id} ${issue.title}` }
}

export function formatPlainActivityValue(value: string | null): IssueActivityValueView {
  if (isEmptyActivityValue(value)) {
    return activityToken('empty')
  }

  const trimmed = value.trim()
  if (trimmed.length > 96) {
    return activityToken('changed')
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
    return activityToken('changed')
  }
  if (/^(external_provider_target|provider_target|agent_session)_/.test(trimmed)) {
    return activityToken('changed')
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return activityToken('changed')
  }
  return { kind: 'text', text: trimmed }
}

export function parseActivityStringArray(value: string | null): string[] | null {
  if (value == null || value === '') {
    return []
  }

  try {
    const parsed = JSON.parse(value) as unknown
    if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) {
      return parsed
    }
  }
  catch {
    return null
  }

  return null
}

export function isEmptyActivityValue(value: string | null): value is null | '' | '[]' {
  return value == null || value === '' || value === '[]'
}

export function activityText(text: string | null): IssueActivityValueView | null {
  const trimmed = text?.trim()
  if (!trimmed) {
    return null
  }
  return { kind: 'text', text: trimmed }
}

export function activityToken(token: IssueActivityValueToken): IssueActivityValueView {
  return { kind: 'token', token }
}

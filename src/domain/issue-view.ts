import { z } from 'zod'

import type { Issue, IssueComment, IssueFieldChange } from '../sqlite/schema'

/** An issue row with its `labels` column decoded from JSON. */
export type IssueView = Omit<Issue, 'labels'> & { labels: string[] }

/**
 * Who a board change is attributed to. The `issue_field_changes.actor_kind`
 * column owns the union; comment authors carry the same kinds plus the
 * `system.*` markers that `normalizeCommentAuthorKind` folds away.
 */
export type IssueActorKind = IssueFieldChange['actorKind']

const IssueLabelsJsonSchema = z.string()
  .transform(raw => JSON.parse(raw))
  .pipe(z.array(z.string()))

export function toIssueView(issue: Issue): IssueView {
  return {
    ...issue,
    labels: IssueLabelsJsonSchema.parse(issue.labels),
  }
}

/**
 * Fold a comment's author kind onto the actor kinds a reader renders: only a
 * person, an agent and a provider target speak for themselves, so every
 * `system.*` marker — whatever it marks — is the board speaking as `system`.
 */
export function normalizeCommentAuthorKind(authorKind: IssueComment['authorKind']): IssueActorKind {
  if (authorKind === 'user' || authorKind === 'agent' || authorKind === 'provider-target') {
    return authorKind
  }
  return 'system'
}

/** Who a row is filed under, as the row stores it — what a host resolves into a name to show. */
export interface IssueActorReference {
  kind: IssueActorKind
  id: string | null
  sourceChatSessionId: string | null
}

/** What a stored row says about who wrote it: the name its writer gave, and the chat session it came from. */
export interface IssueWriterProvenance {
  authorId: IssueComment['authorId']
  sourceChatSessionId: IssueComment['sourceChatSessionId']
}

/**
 * Was this row written by an outside writer?
 *
 * An outside writer is stored as `system`, the same kind the board writes
 * under, so the kind alone cannot say. What a row carries can: a writer from
 * outside — the `kanbo` command line, an agent someone ran themselves — gives
 * a name and speaks from no chat session, while the board writing on its
 * own behalf gives no name (`BOARD_ACTOR`) and an app's agent runtime filed under
 * `system` always carries the session it was called in. The caller establishes
 * the `system` kind first; this answers the rest of the question, and says in
 * its type that such a writer has a name to show.
 */
export function isOutsideWriter(provenance: IssueWriterProvenance): provenance is IssueWriterProvenance & { authorId: string } {
  return provenance.authorId !== null && provenance.sourceChatSessionId === null
}

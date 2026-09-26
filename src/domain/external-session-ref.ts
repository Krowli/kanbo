import { BoardError } from './errors'

/**
 * Where an external agent's own log of a run lives, once it has said (ruling
 * 7-1): which tool wrote it, and the id that tool knows the session by.
 */
export interface ExternalSessionRef {
  provider: 'claude' | 'codex'
  /**
   * The tool's own id for the session — a Claude Code session id, or a Codex
   * session id (the one in the rollout's `session_meta`, which Codex prints).
   */
  id: string
}

/** `claude:<id>` or `codex:<id>`, the id made of anything a filename may hold. */
const EXTERNAL_SESSION_REF = /^(claude|codex):([\w.-]+)$/

/**
 * Read an external session reference out of what an agent passed to
 * `kanbo run start --session` or `kanbo run attach-session`: `claude:<id>` —
 * a Claude Code session id — or `codex:<id>` — a Codex session id. Anything
 * else is refused with `board_run_session_ref_invalid` rather than stored
 * unread, because a ref this build cannot parse back is a transcript nobody
 * can ever open.
 *
 * Doubles as the validator: a caller that only needs to know whether a string
 * is well formed calls this and catches the throw, the same as
 * `parsePullRequestRef`.
 */
export function parseExternalSessionRef(input: string): ExternalSessionRef {
  const match = EXTERNAL_SESSION_REF.exec(input.trim())
  if (!match) {
    throw new BoardError('board_run_session_ref_invalid', { value: input })
  }
  return { provider: match[1] as ExternalSessionRef['provider'], id: match[2]! }
}

/** The stored and printed form: `claude:<id>` or `codex:<id>`. */
export function formatExternalSessionRef(ref: ExternalSessionRef): string {
  return `${ref.provider}:${ref.id}`
}

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * One file kanbo may write, worked out before anything is written.
 *
 * Every setup command — `kanbo init`, `kanbo init --global`, `kanbo uninstall`
 * — first works out what each file would say afterwards, so the person can be
 * shown the whole plan and asked once, and a file that already says it is
 * reported as `unchanged` rather than rewritten.
 */
export interface FileChange {
  path: string
  /** The file's contents afterwards, or `null` when it already says this. */
  next: string | null
}

/** What happened to one file this command may write. */
export interface FileOutcome {
  path: string
  /** `written` when the file changed, `unchanged` when it already said this. */
  state: 'written' | 'unchanged'
}

/** Write the change, creating the directory it lives in, and say what happened. */
export function applyFileChange(change: FileChange): FileOutcome {
  if (change.next === null) {
    return { path: change.path, state: 'unchanged' }
  }
  mkdirSync(dirname(change.path), { recursive: true })
  writeFileSync(change.path, change.next)
  return { path: change.path, state: 'written' }
}

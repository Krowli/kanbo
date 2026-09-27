import type { RmOptions } from 'node:fs'
import { renameSync, rmSync } from 'node:fs'

/**
 * A file operation tried again while something else holds the file.
 *
 * On Windows a file another process has open — an antivirus scan, the search
 * indexer, an editor, a second kanbo — cannot be renamed, removed or rewritten
 * for a moment, and the call fails with `EBUSY`, `EPERM` or `EACCES` rather
 * than waiting. The same operation a few milliseconds later goes through, so it
 * is tried up to 8 times, waiting 25 ms and doubling up to 800 ms between tries
 * (about 2.4 s in all) before the error is let through.
 *
 * `EBUSY` means the same thing everywhere. `EPERM` and `EACCES` mean "held
 * open" only on Windows; elsewhere they are a real permission problem that
 * waiting will not fix, so they fail at once.
 */

const ATTEMPTS = 8
const FIRST_DELAY_MS = 25
const LONGEST_DELAY_MS = 800

export function withFsRetry<T>(operation: () => T, platform: NodeJS.Platform = process.platform): T {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return operation()
    }
    catch (error) {
      if (attempt >= ATTEMPTS || !isHeldOpen(error, platform)) {
        throw error
      }
      sleep(Math.min(FIRST_DELAY_MS * 2 ** (attempt - 1), LONGEST_DELAY_MS))
    }
  }
}

export function renameWithRetry(from: string, to: string): void {
  withFsRetry(() => renameSync(from, to))
}

export function removeWithRetry(path: string, options?: RmOptions): void {
  withFsRetry(() => rmSync(path, options))
}

function isHeldOpen(error: unknown, platform: NodeJS.Platform): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'EBUSY' || (platform === 'win32' && (code === 'EPERM' || code === 'EACCES'))
}

/** Every caller is synchronous, so the wait is too. */
function sleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

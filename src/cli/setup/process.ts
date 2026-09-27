import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from 'node:child_process'

import crossSpawn from 'cross-spawn'

/**
 * Run another program to the end and read what it said.
 *
 * Every program kanbo starts goes through here, never `child_process`
 * directly. On Windows most command-line tools are `.cmd` shims, which Node
 * does not start without a shell, and a shell needs the arguments quoted its
 * own way; `cross-spawn` does both, and elsewhere it is plain `spawnSync`.
 */
export function spawnCommandSync(
  command: string,
  args: readonly string[],
  options: Omit<SpawnSyncOptionsWithStringEncoding, 'encoding'> = {},
): SpawnSyncReturns<string> {
  return crossSpawn.sync(command, [...args], { ...options, encoding: 'utf8' })
}

/**
 * Start another program and let it run on its own — a browser, say — without
 * waiting for it and without failing when it cannot be started.
 */
export function spawnDetached(command: string, args: readonly string[]): void {
  try {
    const child = crossSpawn(command, [...args], { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
  }
  catch {
    // Nothing to start it with: the caller has already shown what it would have opened.
  }
}

/** How to run a program that reads its input and exits. */
export interface RunWithInputOptions {
  /** Give up — and stop the program — after this long. */
  timeoutMs: number
  /**
   * Start it in a process group of its own and do not hold on to it. For a
   * program that forks a copy of itself to stay behind — `xclip` keeps serving
   * the clipboard — and must outlive kanbo.
   */
  detached?: boolean
}

/**
 * Run a program with this input on its stdin and say whether it exited `0`.
 * Never throws: a program that is not installed, fails or hangs past the
 * timeout is `false`, and the caller tries the next thing. Its output is
 * dropped — nothing it prints reaches kanbo's own stdout.
 */
export function runWithInput(
  command: string,
  args: readonly string[],
  input: Uint8Array,
  options: RunWithInputOptions,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const settle = (ok: boolean): void => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolve(ok)
      }
    }
    let child: ReturnType<typeof crossSpawn>
    try {
      child = crossSpawn(command, [...args], {
        detached: options.detached ?? false,
        stdio: ['pipe', 'ignore', 'ignore'],
        windowsHide: true,
      })
    }
    catch {
      resolve(false)
      return
    }
    const timer = setTimeout(() => {
      child.kill()
      settle(false)
    }, options.timeoutMs)
    child.on('error', () => settle(false))
    child.on('exit', code => settle(code === 0))
    child.stdin?.on('error', () => {})
    child.stdin?.end(input)
    if (options.detached) {
      child.unref()
    }
  })
}

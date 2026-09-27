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

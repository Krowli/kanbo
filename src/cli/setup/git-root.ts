import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * The root of the git repository this folder is in, or `null` outside one. A
 * `.git` file counts as much as a `.git` folder: a worktree and a submodule
 * have a file there.
 */
export function findGitRoot(startDir: string): string | null {
  let directory = resolve(startDir)
  while (true) {
    if (existsSync(join(directory, '.git'))) {
      return directory
    }
    const parent = dirname(directory)
    if (parent === directory) {
      return null
    }
    directory = parent
  }
}

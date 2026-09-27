import { readFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'

/**
 * The script an npm command shim on Windows starts.
 *
 * A global install there puts `kanbo.cmd` and `kanbo.ps1` on `PATH`, not the
 * package's script: each is a few lines that run node on
 * `node_modules/kanbo-cli/dist/cli.cjs`, named relative to the shim's own
 * folder (`%dp0%` in the `.cmd`, `$basedir` in the `.ps1`). The doctor compares
 * that script with the one it is running from, so it reads the path back out.
 *
 * Returns the path itself for anything that is not such a shim, and `null` for
 * a shim it cannot read a script out of.
 */
export function resolveShimTarget(path: string): string | null {
  const extension = extname(path).toLowerCase()
  if (extension !== '.cmd' && extension !== '.ps1') {
    return path
  }
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  }
  catch {
    return null
  }
  const relative = parseShimTarget(text)
  return relative === null ? null : join(dirname(path), ...relative.split(/[\\/]+/).filter(Boolean))
}

/** The script a shim's text runs, relative to the shim's folder, or `null` when it names none. */
export function parseShimTarget(text: string): string | null {
  const pattern = /"(?:%dp0%|%~dp0|\$basedir)[\\/]([^"]+)"/g
  let target: string | null = null
  for (const match of text.matchAll(pattern)) {
    const relative = match[1]!
    // The shim also names a node.exe it prefers when one sits beside it.
    if (!/^node(?:\.exe|\$exe)?$/i.test(relative)) {
      target = relative
    }
  }
  return target
}


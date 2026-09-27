import { homedir } from 'node:os'
import { relative } from 'node:path'

/**
 * A path under the person's home folder, as `~/…`; any other path as it is,
 * with forward slashes.
 *
 * Asked of `relative`, not of the path's first characters: `/Users/ab` is not
 * under `/Users/a`, and on Windows `relative` compares without case, so
 * `c:\Users\a\x` is under `C:\Users\a`. A path on another drive comes back
 * from it absolute (`D:…`), which is not under home either.
 */
export function tildify(path: string, home: string = homedir()): string {
  const inside = relative(home, path)
  return inside && !inside.startsWith('..') && !/^[a-z]:/i.test(inside) ? `~/${inside.replaceAll('\\', '/')}` : path.replaceAll('\\', '/')
}

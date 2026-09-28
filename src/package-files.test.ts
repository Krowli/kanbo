import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * What `npm pack` puts in the tarball, from the build this checkout has.
 *
 * Source maps were over half of it and are no use from an installed bundle,
 * the migration chains used to ship twice (at the package root and copied
 * into `dist/`, which is the copy every entry point reads —
 * `migrations-path.ts`), and the changelog is what someone upgrading reads.
 */

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const built = existsSync(join(packageRoot, 'dist', 'cli.cjs'))

describe.skipIf(!built)('the npm tarball', () => {
  const [pack] = built
    ? JSON.parse(execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
        cwd: packageRoot,
        encoding: 'utf8',
        shell: process.platform === 'win32',
      })) as { files: { path: string }[] }[]
    : [{ files: [] }]
  const paths = pack!.files.map(file => file.path)

  it('ships no source maps', () => {
    expect(paths.filter(path => path.endsWith('.map'))).toEqual([])
  })

  it('ships each migration chain once, in dist/', () => {
    expect(paths.filter(path => path.startsWith('drizzle-'))).toEqual([])
    expect(paths).toContain('dist/drizzle-sqlite/meta/_journal.json')
    expect(paths).toContain('dist/drizzle-postgres/meta/_journal.json')
  })

  it('ships the changelog', () => {
    expect(paths).toContain('CHANGELOG.md')
  })
})

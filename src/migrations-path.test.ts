import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { resolveBoardMigrationsPath } from './migrations-path'
import { getBoardMigrationsPath } from './postgres/migrations-path'
import { getBoardSqliteMigrationsPath } from './sqlite/migrate'

/** A machine that has exactly these folders, and nothing else. */
function only(...folders: string[]): (folder: string) => boolean {
  return folder => folders.includes(folder)
}

describe('where the board\'s migrations are', () => {
  it('finds the package root from the source layout', () => {
    const here = join('/repo', 'packages', 'kanbo', 'src', 'postgres')
    const packageRoot = join('/repo', 'packages', 'kanbo', 'drizzle-postgres')

    expect(resolveBoardMigrationsPath(here, 'drizzle-postgres', only(packageRoot))).toBe(packageRoot)
  })

  it('finds the copy beside the bundle from the dist layout', () => {
    // An app that embeds the command ships `dist/` and nothing above it, so this copy is
    // the only migrations folder there is.
    const here = join('/Applications', 'Host.app', 'Contents', 'Resources', 'kanbo')
    const besideTheBundle = join(here, 'drizzle-postgres')

    expect(resolveBoardMigrationsPath(here, 'drizzle-postgres', only(besideTheBundle))).toBe(besideTheBundle)
  })

  it('names the source layout when neither is there, so the complaint is about the checkout', () => {
    const here = join('/repo', 'packages', 'kanbo', 'src', 'postgres')

    expect(resolveBoardMigrationsPath(here, 'drizzle-postgres', only()))
      .toBe(join('/repo', 'packages', 'kanbo', 'drizzle-postgres'))
  })

  it('answers the same way for the file dialect, which is the other folder', () => {
    const here = join('/repo', 'packages', 'kanbo', 'src', 'sqlite')

    expect(resolveBoardMigrationsPath(here, 'drizzle-sqlite', only()))
      .toBe(join('/repo', 'packages', 'kanbo', 'drizzle-sqlite'))
  })

  it('finds the package root from the library build, one directory deeper than the checkout', () => {
    // `tsdown.lib.config.ts` nests each entry under its own subpath —
    // `dist/lib/postgres/index.mjs` — one level deeper than `src/postgres/`,
    // so the package root sits one `..` further up.
    const here = join('/repo', 'packages', 'kanbo', 'dist', 'lib', 'postgres')
    const packageRoot = join('/repo', 'packages', 'kanbo', 'drizzle-postgres')

    expect(resolveBoardMigrationsPath(here, 'drizzle-postgres', only(packageRoot))).toBe(packageRoot)
  })

  it('finds the published copy from the library build inside an installed tarball', () => {
    // An external consumer's `node_modules/kanbo` has no `src/` —
    // `drizzle-sqlite/` is there because `package.json`'s `files` publishes it
    // at the package root, the same place a checkout keeps it.
    const here = join('/proj', 'node_modules', 'kanbo', 'dist', 'lib', 'sqlite')
    const packageRoot = join('/proj', 'node_modules', 'kanbo', 'drizzle-sqlite')

    expect(resolveBoardMigrationsPath(here, 'drizzle-sqlite', only(packageRoot))).toBe(packageRoot)
  })

  it('hands both migrators a folder that is really there, running from where it runs now', () => {
    expect(existsSync(join(getBoardMigrationsPath(), 'meta', '_journal.json'))).toBe(true)
    expect(existsSync(join(getBoardSqliteMigrationsPath(), 'meta', '_journal.json'))).toBe(true)
  })
})

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * `better-sqlite3` is an optional dependency, and this is what says so
 * honestly rather than in a `package.json` field nobody executes.
 *
 * The native module is *not* uninstalled to prove it — it is a devDependency of
 * this package and every other test needs it. It is made unresolvable instead,
 * in a child process, by a resolve hook for ESM and a `Module._resolveFilename`
 * patch for CJS, which together cover both halves of the built output. What
 * then has to hold is that `kanbo capabilities --json` still answers and every
 * built entry point still imports: a Postgres-only or capabilities-only install
 * carries no native module, and so does an install where npm could not build
 * it — an optional dependency that fails is left out, not an error.
 *
 * It runs against `dist`, because the defect it guards was invisible in source:
 * the eager `import Client from "better-sqlite3"` inside
 * `drizzle-orm/better-sqlite3/driver.js` only becomes a top-level `require` at
 * the top of a bundle once the bundler has hoisted it. A checkout that has not
 * been built has nothing to say here, so the suite skips rather than fails.
 */

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(packageRoot, 'dist')

/** The entry points that must load with no native module in reach, as `dist/lib` spells them. */
const LIBRARY_ENTRIES = [
  'index',
  'postgres/index',
  'mcp/index',
  'sqlite/schema',
  // `./sqlite` is on this list too: it is where a board file is opened, and the
  // point of the lazy load is that holding the opener is not holding the file.
  'sqlite/index',
] as const

/** Where the hooks that hide the module are written; one directory for the whole file. */
let hideDir: string

/** The `--import` argument that makes `better-sqlite3` unresolvable in a child node. */
let hide: string

const built = existsSync(join(dist, 'cli.cjs')) && existsSync(join(dist, 'lib', 'index.mjs'))

beforeAll(() => {
  hideDir = mkdtempSync(join(tmpdir(), 'kanbo-no-sqlite-'))
  const hooks = join(hideDir, 'hooks.mjs')
  writeFileSync(hooks, [
    'const HIDDEN = /^better-sqlite3(?:\\/|$)/',
    'export async function resolve(specifier, context, next) {',
    '  if (HIDDEN.test(specifier)) {',
    '    const error = new Error(\'Cannot find package \' + specifier)',
    '    error.code = \'ERR_MODULE_NOT_FOUND\'',
    '    throw error',
    '  }',
    '  return await next(specifier, context)',
    '}',
    '',
  ].join('\n'))

  hide = join(hideDir, 'hide.mjs')
  writeFileSync(hide, [
    'import Module, { register } from \'node:module\'',
    'const HIDDEN = /^better-sqlite3(?:\\/|$)/',
    'const resolveFilename = Module._resolveFilename',
    'Module._resolveFilename = function (request, ...rest) {',
    '  if (HIDDEN.test(request)) {',
    '    const error = new Error(\'Cannot find module \' + request)',
    '    error.code = \'MODULE_NOT_FOUND\'',
    '    throw error',
    '  }',
    '  return resolveFilename.call(this, request, ...rest)',
    '}',
    `register(${JSON.stringify(pathToFileURL(hooks).href)})`,
    '',
  ].join('\n'))
})

afterAll(() => {
  rmSync(hideDir, { force: true, recursive: true })
})

/** Run node with the native module hidden, and hand back what it printed. */
function withoutBetterSqlite3(args: string[]): string {
  return execFileSync(process.execPath, ['--import', pathToFileURL(hide).href, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

describe.skipIf(!built)('the library and the binary without better-sqlite3', () => {
  it('runs kanbo capabilities --json, which opens no board at all', () => {
    const printed = withoutBetterSqlite3([join(dist, 'cli.cjs'), 'capabilities', '--json'])

    expect(JSON.parse(printed)).toEqual(expect.objectContaining({ package: expect.objectContaining({ name: 'kanbo' }) }))
  })

  it('prints the binary\'s own help rather than a module-resolution stack', () => {
    expect(withoutBetterSqlite3([join(dist, 'cli.cjs'), '--help'])).toContain('kanbo [options] [command]')
  })

  it.each(LIBRARY_ENTRIES)('imports dist/lib/%s.mjs', (entry) => {
    const printed = withoutBetterSqlite3([
      '--input-type=module',
      '-e',
      `const loaded = await import(${JSON.stringify(pathToFileURL(join(dist, 'lib', `${entry}.mjs`)).href)}); console.log(Object.keys(loaded).length > 0)`,
    ])

    expect(printed.trim()).toBe('true')
  })

  it.each(LIBRARY_ENTRIES)('requires dist/lib/%s.cjs', (entry) => {
    const printed = withoutBetterSqlite3([
      '--input-type=commonjs',
      '-e',
      `console.log(Object.keys(require(${JSON.stringify(join(dist, 'lib', `${entry}.cjs`))})).length > 0)`,
    ])

    expect(printed.trim()).toBe('true')
  })

  it('still says what to install when a board file is actually opened', () => {
    const attempt = (): string => withoutBetterSqlite3([
      '--input-type=module',
      '-e',
      `const { openBoardDatabase } = await import(${JSON.stringify(pathToFileURL(join(dist, 'lib', 'sqlite', 'index.mjs')).href)})\n`
      + `await openBoardDatabase(${JSON.stringify(join(hideDir, 'board.db'))})`,
    ])

    expect(attempt).toThrowError(`Could not load better-sqlite3, which kanbo opens board files with, on Node ${process.version} (${process.platform}-${process.arch}): Cannot find module better-sqlite3`)
    expect(attempt).toThrowError('Reinstall kanbo with npm install -g kanbo-cli')
  })
})

describe('how better-sqlite3 is declared', () => {
  it('is an optional dependency, so npm install -g kanbo-cli brings it along, and not a peer any more', () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))

    expect(manifest.optionalDependencies['better-sqlite3']).toBe('^13.0.3')
    expect(manifest.peerDependencies['better-sqlite3']).toBeUndefined()
    expect(manifest.peerDependenciesMeta['@types/better-sqlite3']).toEqual({ optional: true })
  })
})

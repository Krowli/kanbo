import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * The package root's `package.json`, found relative to the file asking for
 * it — the same reason `migrations-path.ts` resolves a candidate rather than
 * a fixed `../`: this file's own compiled output does not always land at the
 * same depth. One level up is the package root from `src/package-version.ts`
 * in a checkout and from `dist/cli.cjs`'s single bundle; two levels up is the
 * same root from a `dist/lib/*` chunk, because the library build nests every
 * entry — and the shared chunk this file becomes part of — one directory
 * deeper than the CLI's one bundle.
 */
function resolvePackageJsonPath(): string {
  const oneUp = join(here, '..', 'package.json')
  return existsSync(oneUp) ? oneUp : join(here, '..', '..', 'package.json')
}

/**
 * The version a build wrote in. `tsdown` replaces this identifier with the
 * literal from `package.json` in both builds (`tsdown.cli.config.ts`,
 * `tsdown.lib.config.ts`), because a built copy may live where no
 * `package.json` exists at all — an app that embeds the command may ship `dist/` alone.
 */
declare const __KANBO_PACKAGE_VERSION__: string | undefined

/**
 * This build's own version, one source for the CLI's `--version`, the MCP
 * server's reported version and the capabilities manifest's
 * `package.version`. A build carries it as a literal; running from source
 * (tests, `tsx`) reads the package's own `package.json` instead.
 */
export const KANBO_PACKAGE_VERSION: string
  = typeof __KANBO_PACKAGE_VERSION__ === 'string'
    ? __KANBO_PACKAGE_VERSION__
    : (JSON.parse(readFileSync(resolvePackageJsonPath(), 'utf-8')) as { version: string }).version

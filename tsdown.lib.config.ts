import { readFileSync } from 'node:fs'

import { defineConfig } from 'tsdown'

/**
 * The library build: what `dist/lib/` is for an installer of the
 * package, and what `package.json`'s `exports` point a bare `import
 * 'kanbo/...'` at once `dist` exists.
 *
 * Unlike `tsdown.cli.config.ts`, nothing here is bundled in. Every runtime
 * dependency (`drizzle-orm`, `postgres`, `better-sqlite3`, `zod`, `commander`,
 * `@modelcontextprotocol/sdk`, `@clack/prompts`, `picocolors`) stays an
 * `import`/`require` in the output, which is tsdown's default for anything
 * listed under `dependencies` or `peerDependencies` — a consumer installs this
 * package the ordinary way and gets its own copy of each, rather than a second
 * one baked into ours. The one entry point this deliberately leaves out is
 * `./testing`: it pulls in `@electric-sql/pglite`, a development dependency of
 * this package's own tests, and has no reason to exist outside a checkout.
 *
 * Each entry keeps its source subpath (`sqlite/index`, not `sqlite`) so the
 * compiled layout mirrors `src/`'s own depth — `getBoardMigrationsPath` and
 * `getBoardSqliteMigrationsPath` resolve relative to `import.meta.url`, and
 * `src/migrations-path.ts`'s candidates are written for a fixed number of
 * directories between the running file and the package root.
 */
/** The version every build carries as a literal (see `src/package-version.ts`). */
const PACKAGE_VERSION = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')) as { version: string }).version

export default defineConfig({
  define: { __KANBO_PACKAGE_VERSION__: JSON.stringify(PACKAGE_VERSION) },
  entry: {
    'index': 'src/index.ts',
    'sqlite/index': 'src/sqlite/index.ts',
    'sqlite/schema': 'src/sqlite/schema.ts',
    'postgres/index': 'src/postgres/index.ts',
    'mcp/index': 'src/mcp/index.ts',
  },
  outDir: 'dist/lib',
  format: ['esm', 'cjs'],
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  clean: true,
  dts: true,
  // Rolldown's own format string is `es`, not the `esm` alias `format` above accepts.
  outExtensions: ({ format }) => ({
    js: format === 'es' ? '.mjs' : '.cjs',
  }),
})

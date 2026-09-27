import { readFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'

import { defineConfig } from 'tsdown'

/** The one dependency that cannot be bundled, and the subpaths under it. */
const NATIVE_DEPENDENCY = /^better-sqlite3(?:\/|$)/

/**
 * The `kanbo` command, `dist/cli-main.cjs`.
 *
 * The binary itself, `dist/cli.cjs`, is `src/cli/launcher.cjs`, copied in by
 * `scripts/copy-build-assets.mjs`: a few lines any Node can parse, which check
 * the Node version and then require this bundle — so an old Node is told which
 * one to install rather than handed a SyntaxError from the bundle's own syntax.
 *
 * CJS, so the file node runs is one file — and here that is
 * meant literally: an app that embeds the command may ship `dist/` alone, with
 * no `node_modules` beside it, so every dependency that stays external is one
 * the packaged command cannot find.
 *
 * `better-sqlite3` is the single exception. It is a native module, a `.node`
 * binding is not something a bundler can inline: an npm install resolves it
 * from `node_modules`, and an app that ships `dist/` alone puts a copy built
 * for its own runtime on `NODE_PATH`. Everything else — every npm dependency
 * this binary uses — is bundled into `dist/`.
 */
/** The version every build carries as a literal (see `src/package-version.ts`). */
const PACKAGE_VERSION = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')) as { version: string }).version

export default defineConfig({
  define: { __KANBO_PACKAGE_VERSION__: JSON.stringify(PACKAGE_VERSION) },
  entry: { 'cli-main': 'src/cli/index.ts' },
  format: ['cjs'],
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  clean: true,
  outExtensions: () => ({ js: '.cjs' }),
  // A dynamic import has to stay one: rolldown hoists every external `require`
  // in a chunk to the top of it, so a `drizzle-orm/better-sqlite3` folded into
  // `cli-main.cjs` puts `require("better-sqlite3")` on the startup path of `kanbo
  // capabilities`, a command that opens no board at all — which is precisely
  // the optional peer dependency broken (finding A1,
  // `src/optional-sqlite.test.ts`). Splitting keeps that require inside the
  // chunk the driver lands in, loaded the first time a board file is opened and
  // never before. `@clack/prompts`, which `kanbo init` also reaches behind a
  // dynamic import, splits off for the same reason and costs nothing: the
  // packaged app and the npm tarball both ship the whole of `dist/`, and the
  // launcher still names `cli-main.cjs`.
  outputOptions: {
    codeSplitting: true,
  },
  deps: {
    neverBundle: [NATIVE_DEPENDENCY],
    alwaysBundle: id => !isBuiltin(id) && !NATIVE_DEPENDENCY.test(id),
    onlyBundle: false,
  },
  dts: false,
})

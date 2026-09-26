import { defineConfig } from 'tsdown'

/**
 * The board page `kanbo serve` answers `/` with (`src/serve/board-page.ts`):
 * one script and one stylesheet in `dist/page/`, beside the bundled binary.
 *
 * A browser runs it, so it is a single IIFE with nothing left to import — the
 * page's CSP allows scripts from the server itself and nowhere else — and it
 * carries no source map, which the server does not serve. The stylesheet is
 * one hand-written file and is copied as it is.
 */
export default defineConfig({
  entry: { board: 'src/serve/page/main.ts' },
  outDir: 'dist/page',
  format: ['iife'],
  platform: 'browser',
  target: 'es2022',
  tsconfig: 'src/serve/page/tsconfig.json',
  sourcemap: false,
  minify: true,
  clean: true,
  dts: false,
  outputOptions: { entryFileNames: 'board.js' },
  copy: [{ from: 'src/serve/page/board.css', to: 'dist/page' }],
})

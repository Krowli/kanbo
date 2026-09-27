import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Clears the marks an agent tool leaves in the shell it runs `npm test` in.
    setupFiles: ['src/testing/vitest-setup.ts'],
    // Several tests start a child node process against the built output, and a
    // busy CI runner can take longer than vitest's default 5 s to answer.
    testTimeout: 30_000,
    // The Postgres scenarios start an embedded server (PGlite, WebAssembly) and
    // migrate it in `beforeEach`/`beforeAll`. That takes under a second on an idle
    // machine and more than vitest's default 10 s hook budget on a loaded one —
    // every failure seen was that timeout, never an assertion.
    hookTimeout: 30_000,
  },
})

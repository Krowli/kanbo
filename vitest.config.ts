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
    // `npm run coverage`. The thresholds are one point below the lower of what
    // the suite measured on macOS and on Linux (CI) when they were set, rounded
    // down to a tenth: the two differ by a few tenths (platform-only branches),
    // and the point of margin keeps that from failing a run. Coverage may rise,
    // and a change that lowers it by more than the margin fails. Raise them when
    // it rises. Code run only in a child process (the built CLI a test starts)
    // is not counted.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/testing/**'],
      reporter: ['text-summary', 'lcov'],
      reportsDirectory: 'coverage',
      // Measured 2026-09-28, Node 24 — Linux (CI run for 3e69998): 86.71 / 81.26 / 90.25 / 86.59;
      // macOS (after the phase-7 fixes): 86.82 / 81.46 / 90.30 / 86.70.
      thresholds: { statements: 85.7, branches: 80.2, functions: 89.2, lines: 85.5 },
    },
  },
})

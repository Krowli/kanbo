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
  },
})

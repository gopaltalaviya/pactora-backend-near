import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts', 'apps/agents/*/test/**/*.test.ts'],
    // The API tests share one Postgres schema and TRUNCATE between cases, so
    // they must not run concurrently with each other.
    fileParallelism: false,
    testTimeout: 30_000,
    // Explicit: a slow hook reports as a hook timeout, never as a failure of
    // whichever test happened to run first.
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**', 'apps/*/src/**'],
      // Entry points are wiring — environment, listeners, signals — and are
      // exercised by the live runs (demo, e2e), not by unit tests.
      exclude: ['**/main.ts', '**/*.d.ts'],
      reporter: ['text-summary', 'lcov'],
      // Floors just below today's numbers (77 / 81 / 76 / 77, 2026-09-30):
      // a change that adds untested code fails CI rather than eroding them.
      thresholds: {statements: 75, branches: 78, functions: 74, lines: 75},
    },
  },
});

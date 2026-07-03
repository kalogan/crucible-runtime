import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['benchmarks/**', 'node_modules/**', 'dist/**'],
    // A hung test must abort the run, not wedge it (PIPELINE.md §4-prevention).
    testTimeout: 30_000,
    hookTimeout: 30_000,
    teardownTimeout: 10_000,
  },
});

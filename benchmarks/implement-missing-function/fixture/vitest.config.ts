import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // A pathological edit must fail fast, never wedge the runner.
    testTimeout: 5_000,
    hookTimeout: 5_000,
  },
});

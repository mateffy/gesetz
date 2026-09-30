import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Every test run gets its own cache directory: tests must not mutate the
    // developer's cache, and must not contend for it with another gesetz process.
    setupFiles: ['tests/setup-cache-isolation.ts'],
  },
});

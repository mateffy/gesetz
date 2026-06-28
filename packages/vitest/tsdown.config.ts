import { defineConfig } from 'tsdown';

/**
 * Per-package build config for @gesetz/vitest.
 *
 * Prevents tsdown from walking up to the root workspace config (which uses
 * `workspace: 'packages/*'` and fails when prepack runs tsdown from inside
 * a sub-package). This config builds the single src/index.ts entry with the
 * same options as the root workspace config.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
});

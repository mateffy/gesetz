import { defineConfig } from 'tsdown';

/**
 * Per-package build config for @gesetz/tsc.
 *
 * Prevents tsdown from walking up to the root workspace config (which uses
 * `workspace: 'packages/*'` and fails when prepack runs tsdown from inside a
 * sub-package).
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
});

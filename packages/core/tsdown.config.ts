import { defineConfig } from 'tsdown';

/**
 * @gesetz/core — standard build plus the ./reporters subpath export.
 *
 * The root workspace config builds src/index.ts → dist/index.js; this
 * per-package config adds src/reporters/index.ts → dist/reporters.js so
 * the `exports["./reporters"]` entry in package.json resolves.
 *
 * `vitest` and `bun:test` are externalized: they are runtime-provided test
 * runners imported dynamically by the defineQualityTestsVitest /
 * defineQualityTestsBunTest helpers. They must not be bundled — consumers
 * provide them when they opt into those helpers.
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/reporters/index.ts'],
  format: ['esm'],
  dts: true,
  clean: false,
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  external: ['vitest', 'bun:test'],
});

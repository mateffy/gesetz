import { defineConfig } from 'tsdown';

/**
 * Root workspace build config.
 *
 * `tsdown -W` auto-detects every package in packages/* and builds it with
 * these shared defaults: ESM output, .d.ts generation, clean dist. Each
 * package's `dependencies`/`peerDependencies` are auto-externalized, so
 * @gesetz/* cross-package deps and the Effect ecosystem resolve from
 * node_modules at runtime — never bundled in.
 *
 * Two packages override these defaults with their own per-package
 * tsdown.config.ts:
 *   - packages/core   (extra ./reporters subpath entry + vitest/bun:test external)
 *   - packages/cli    (bundled executable with node shebang + externals)
 *
 * outExtensions forces `.js`/`.d.ts` (not `.mjs`/`.d.mts`) since every
 * package declares `"type": "module"`, making `.js` ESM by default.
 */
export default defineConfig({
  workspace: 'packages/*',
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: false,
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
});

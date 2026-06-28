import { defineConfig } from 'tsdown';

/**
 * @gesetz/cli — two independent builds (no shared chunks, so no stub files).
 *
 *   - src/main.ts  → dist/main.js   (the `gesetz` bin; shebang injected;
 *                    self-contained bundle with the entry-point side effect)
 *   - src/index.ts → dist/index.js  (programmatic API re-exported by the
 *                    `gesetz` meta-package; imports from the bundled main.js)
 *
 * All @gesetz/* packages, the Effect ecosystem, native parser bindings
 * (oxc-parser, @ast-grep/*), and the test runners (vitest, bun:test) are kept
 * external — they resolve from node_modules at runtime, both in the monorepo
 * (via workspace symlinks) and after publish.
 *
 * Splitting into two configs (rather than two entries in one config) prevents
 * rolldown from code-splitting shared code into a hashed chunk and emitting
 * main.js as a re-export stub — which would drop the `if (isEntryPoint)`
 * side effect that makes the bin actually run.
 */
const external = [
  'oxc-parser',
  '@ast-grep/napi',
  '@ast-grep/lang-php',
  'eslint',
  'jiti',
  '@gesetz/core',
  '@gesetz/typescript',
  '@gesetz/php',
  '@gesetz/oxlint',
  '@gesetz/oxfmt',
  '@gesetz/vitest',
  '@gesetz/bun-test',
  '@gesetz/pest',
  '@gesetz/prettier',
  '@gesetz/junit',
  '@gesetz/effect-ts',
  '@gesetz/eslint',
  '@gesetz/phpstan',
  '@gesetz/storybook',
  '@gesetz/phpunit',
  'effect',
  '@effect/cli',
  '@effect/platform',
  '@effect/platform-node',
  '@effect/platform-node-shared',
  '@effect/printer',
  '@effect/printer-ansi',
  'vitest',
  'bun:test',
];

const shared = {
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  sourcemap: true,
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  external,
};

export default defineConfig([
  // The bin — bundled executable with node shebang. Cleans dist first.
  {
    ...shared,
    entry: ['src/main.ts'],
    dts: true,
    clean: false,
    banner: { js: '#!/usr/bin/env node' },
  },
  // The programmatic API entry. clean: false so it doesn't wipe main.js.
  {
    ...shared,
    entry: ['src/index.ts'],
    dts: true,
    clean: false,
  },
]);

/**
 * Dogfooding: gesetz checks its own codebase.
 *
 * This config is loaded when running `gesetz` in the workspace root.
 * It enforces quality rules on the gesetz monorepo itself.
 */

import {
  defineConfig,
  select,
  noGodFile,
  noDeepNesting,
  noDebuggingResidueFiles,
  noHardcodedSecret,
  noPattern,
  requirePattern,
  requireTest,
  noImportFrom,
  defineArchitecture,
} from '@gesetz/core';
import { oxlint } from '@gesetz/oxlint';
import { oxfmt } from '@gesetz/oxfmt';
import {
  noConsoleLog,
  noEmptyCatch,
  noMagicNumbers,
  noTrivialComment,
  typescriptSyntaxBackend,
} from '@gesetz/typescript';

// ─── Architecture: package import boundaries ──────────────────────────────────

const arch = defineArchitecture({
  layers: [
    // Core is the foundation — every adapter depends on it
    { name: 'core', pattern: 'packages/core/src/**/*', canImportFrom: [] },
    // Adapters wrap external tools; they may import from core
    { name: 'adapters', pattern: 'packages/*/src/adapter.ts' },
    // CLI depends on core
    { name: 'cli', pattern: 'packages/cli/src/**/*', canImportFrom: ['core'] },
    // Wrapper package depends only on core + cli
    { name: 'wrapper', pattern: 'packages/gesetz/src/**/*', canImportFrom: ['core', 'cli'] },
  ],
  forbidden: [
    {
      from: 'core',
      to: 'adapters',
      message: 'Core must not import from adapters — adapters depend on core, not vice versa',
    },
  ],
});

// ─── Config ──────────────────────────────────────────────────────────────────

export default defineConfig({
  // Enable the TypeScript SyntaxBackend so defineArchitecture can extract
  // imports accurately (via oxc-parser) instead of falling back to regex.
  adapters: [typescriptSyntaxBackend],

  thresholds: [
    // Source files with no test yet. Reported so the gap is visible; the
    // threshold is 0 until they are written, then raise it.
    { category: 'testing', minScore: 0 },
    // 116 files are not yet in oxfmt's output format. Reported so the number is
    // visible; run `pnpm exec oxfmt --write packages` once, then raise this.
    // Making it blocking today would mean a 116-file reformat in one commit.
    { category: 'formatting', minScore: 0 },
  ],

  rules: [
    // Architecture
    ...arch,

    // ─── Structure ──────────────────────────────────────────────────────────

    select('packages/**/*.ts')
      .exclude('**/*.test.ts', '**/tests/**', '**/node_modules/**')
      .label('No god files')
      .category('structure')
      .check(noGodFile({ maxLines: 400 })),

    select('packages/**/*.ts')
      .exclude('**/*.test.ts', '**/tests/**', '**/node_modules/**')
      .label('No deep nesting')
      .category('structure')
      .check(noDeepNesting({ maxLevels: 5 })),

    select('packages/**/*.ts')
      .exclude('**/*.test.ts', '**/tests/**', '**/node_modules/**', '**/dist/**')
      .label('No console.log in production')
      .category('cleanup')
      .check(noConsoleLog({ allowWarnError: true })),

    select('packages/**/*.ts')
      .exclude('**/*.test.ts', '**/tests/**', '**/node_modules/**', '**/dist/**')
      .label('No empty catch blocks')
      .category('strictness')
      .check(noEmptyCatch()),

    select('packages/**/*.ts')
      .exclude('**/*.test.ts', '**/tests/**', '**/node_modules/**', '**/dist/**', 'packages/cli/src/init/rules.ts')
      .label('No magic numbers')
      .category('strictness')
      .check(noMagicNumbers({ ignore: [0, 1, -1, 2, 10, 100] })),

    select('packages/**/*.ts')
      .exclude('**/*.test.ts', '**/tests/**', '**/node_modules/**', '**/dist/**')
      .label('No trivial comments')
      .category('cleanup')
      .check(noTrivialComment()),

    // ─── Security ───────────────────────────────────────────────────────────

    select('packages/**/*.ts')
      .exclude('**/*.test.ts', '**/tests/**', '**/node_modules/**', '**/dist/**')
      .label('No hardcoded secrets')
      .category('security')
      .check(noHardcodedSecret()),

    // ─── File naming ────────────────────────────────────────────────────────

    select('packages/**/*')
      .exclude('**/node_modules/**', '**/dist/**', '**/.git/**')
      .label('No debugging residue files')
      .category('cleanup')
      .check(noDebuggingResidueFiles()),

    // ─── Tests must exist ───────────────────────────────────────────────────

    // Every adapter is the integration point with an external tool, so it needs
    // a test. `requireTest` looks co-located AND under `tests/`, because this
    // repository uses the latter — `requireSibling` only ever looked next to the
    // source and reported a missing test for every adapter as a result.
    select('packages/*/src/adapter.ts').label('Adapter files need tests').category('testing').check(
      requireTest({ message: 'Adapter files must have a matching test file' }),
    ),

    // The rest of the source tree: reported, not enforced. 42 files have no test
    // yet, and the `testing` threshold below is set to 0 so the gap is visible in
    // the report without failing the build. Raise it as coverage grows.
    select('packages/**/src/**/*.ts')
      .exclude('**/index.ts', '**/*.d.ts', '**/*.test.ts', '**/tests/**')
      .label('Source files need tests')
      .category('testing')
      .check(requireTest({ severity: 'info' })),

    // ─── External tools ─────────────────────────────────────────────────────
    //
    // These run the repo's own adapters against the repo. `bin` is explicit
    // because a plain `node` invocation does not put node_modules/.bin on PATH.
    //
    // Both adapters now fail closed: a missing tool reports an error instead of
    // silently producing no violations, so a gate that cannot run cannot pass.

    oxlint({
      pattern: 'packages',
      bin: 'node_modules/.bin/oxlint',
      label: 'oxlint',
      category: 'strictness',
    }),

    oxfmt({
      pattern: 'packages',
      bin: 'node_modules/.bin/oxfmt',
      label: 'oxfmt',
      category: 'formatting',
    }),

    // ─── Patterns ───────────────────────────────────────────────────────────

    select('packages/**/*.ts')
      .exclude('**/*.test.ts', '**/tests/**', '**/node_modules/**')
      .label('No TODO(urgent) markers')
      .category('cleanup')
      .check(noPattern(/TODO\(urgent\)/)),

    // ─── README must stay current ─────────────────────────────────────────

    select('README.md').label('README must mention gesetz').check(
      requirePattern(/gesetz/, { message: 'README.md must mention the project name' }),
    ),
  ],
});

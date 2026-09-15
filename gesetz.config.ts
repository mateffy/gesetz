/**
 * Dogfooding: gesetz checks its own codebase.
 *
 * This config is loaded when running `gesetz` in the workspace root.
 * It enforces quality rules on the gesetz monorepo itself.
 */

import * as nodePath from 'node:path';
import {
  defineConfig,
  select,
  noGodFile,
  noDeepNesting,
  noDebuggingResidueFiles,
  noHardcodedSecret,
  noPattern,
  requirePattern,
  noImportFrom,
  defineArchitecture,
} from '@gesetz/core';
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
  rules: [
    // Architecture
    ...arch,

    // ─── Structure ──────────────────────────────────────────────────────────

    select('packages/**/*.ts')
      .exclude('**/*.test.ts', '**/tests/**', '**/node_modules/**')
      .label('No god files')
      .category('structure')
      .check(noGodFile({ maxLines: 400 })),

    // `noDeepNesting` counts *indentation*, not control-flow depth: a callback
    // passed to `.pipe(...)` adds a level exactly as a nested `if` does, and this
    // codebase indents to 6 routinely (Effect generators, nested callbacks).
    // The threshold is therefore set to where indentation stops being readable
    // here — 8 — rather than to a control-flow number that would flag the house
    // style 160+ times. The one file that exceeded it was refactored instead.
    select('packages/**/*.ts')
      .exclude('**/*.test.ts', '**/tests/**', '**/node_modules/**')
      .label('No deep nesting')
      .category('structure')
      .check(noDeepNesting({ maxLevels: 8 })),

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

    // ─── Tests must exist for adapters ──────────────────────────────────────

    // Tests live in `tests/`, not next to the source, so this is a custom check
    // rather than `requireSibling`. `packages/php/src/adapter.ts` is excluded: it is
    // a deliberate stub kept only so stale imports fail with a clear error.
    select('packages/*/src/adapter.ts')
      .exclude('packages/php/src/adapter.ts')
      .label('Adapters need tests')
      .category('organization')
      .check(async (file, { fs }) => {
        const packageDir = nodePath.dirname(nodePath.dirname(file.absolutePath));
        const testFile = nodePath.join(packageDir, 'tests', 'adapter.test.ts');
        if (await fs.exists(testFile)) return [];
        return [
          {
            message: `Adapter has no test file: expected ${file.path.replace('/src/adapter.ts', '/tests/adapter.test.ts')}`,
            path: file.path,
            severity: 'error' as const,
            source: 'core' as const,
          },
        ];
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

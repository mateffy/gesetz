/**
 * Dogfooding: gesetz checks its own codebase.
 *
 * This config is loaded when running `gesetz` in the workspace root.
 * It enforces quality rules on the gesetz monorepo itself.
 */

import {
  defineConfig,
  select,
  noConsoleLog,
  noGodFile,
  noDeepNesting,
  noEmptyCatch,
  noMagicNumbers,
  noTrivialComment,
  noDebuggingResidueFiles,
  noHardcodedSecret,
  noPattern,
  requirePattern,
  requireSibling,
  noImportFrom,
  defineArchitecture,
} from '@gesetz/core';

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
      .exclude('**/*.test.ts', '**/tests/**')
      .label('No console.log in production')
      .category('cleanup')
      .check(noConsoleLog({ allowWarnError: true })),

    select('packages/**/*.ts')
      .exclude('**/*.test.ts', '**/tests/**')
      .label('No empty catch blocks')
      .category('strictness')
      .check(noEmptyCatch()),

    select('packages/**/*.ts')
      .exclude('**/*.test.ts', '**/tests/**', 'packages/cli/src/init/rules.ts')
      .label('No magic numbers')
      .category('strictness')
      .check(noMagicNumbers({ ignore: [0, 1, -1, 2, 10, 100] })),

    select('packages/**/*.ts')
      .exclude('**/*.test.ts', '**/tests/**')
      .label('No trivial comments')
      .category('cleanup')
      .check(noTrivialComment()),

    // ─── Security ───────────────────────────────────────────────────────────

    select('packages/**/*.ts')
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

    select('packages/vitest/src/adapter.ts').label('vitest needs tests').check(
      requireSibling('.test.ts', { message: 'Adapter files must have a matching test file' }),
    ),

    select('packages/prettier/src/adapter.ts').label('prettier needs tests').check(
      requireSibling('.test.ts', { message: 'Adapter files must have a matching test file' }),
    ),

    select('packages/eslint/src/adapter.ts').label('eslint needs tests').check(
      requireSibling('.test.ts', { message: 'Adapter files must have a matching test file' }),
    ),

    select('packages/bun-test/src/adapter.ts').label('bun-test needs tests').check(
      requireSibling('.test.ts', { message: 'Adapter files must have a matching test file' }),
    ),

    select('packages/pest/src/adapter.ts').label('pest needs tests').check(
      requireSibling('.test.ts', { message: 'Adapter files must have a matching test file' }),
    ),

    select('packages/phpstan/src/adapter.ts').label('phpstan needs tests').check(
      requireSibling('.test.ts', { message: 'Adapter files must have a matching test file' }),
    ),

    select('packages/oxfmt/src/adapter.ts').label('oxfmt needs tests').check(
      requireSibling('.test.ts', { message: 'Adapter files must have a matching test file' }),
    ),

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

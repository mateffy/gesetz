/**
 * regel config for immoui — mirrors the existing @regeln/immoui QA rules.
 *
 * This config uses the same primitives as the TS rule files under
 * quality-assurance/immoui/, but is consumed by the `regel` CLI so it can
 * be run independently of vitest.
 *
 * Run with:
 *   regel check --project-root .
 */
import { defineConfig, select, requireSibling, requireChildren, forbidFile, noImportFrom, relativeImports } from '@regeln/core';
import {
  requireExportPairs,
  requireExportFactories,
  requireCallShape,
  noFunctionCalls,
  noHardcodedStrings,
  requireImportBoundary,
  noLocalFunctionComponents,
  noObjectProperty,
  noCrossModuleImports,
  requireDirectoryStructure,
  requireMinTestScore,
} from '@regeln/typescript';
import { oxlint } from '@regeln/oxlint';
import { oxfmt } from '@regeln/oxfmt';
import { vitest } from '@regeln/vitest';
import { storybook } from '@regeln/storybook';

// ─── SDK conventions ──────────────────────────────────────────────────────────

const MUTATION_PREFIXES = [
  'use-create-',
  'use-update-',
  'use-delete-',
  'use-move-',
  'use-duplicate-',
  'use-restore-',
];

const REQUIRED_SUBDOMAIN_FILES = ['index.ts', 'interface.ts', 'http.ts', 'memory.ts', 'types.ts', 'fakes.ts'];
const REQUIRED_HOOKS_FILES = ['index.ts', 'queries.ts'];

const ALLOWED_TANSTACK_PATTERNS = [
  'src/sdk/**',
  'src/router.tsx',
  'src/**/__tests__/**',
  'src/**/*.stories.tsx',
  'src/**/*.test.tsx',
];

// ─── Config ───────────────────────────────────────────────────────────────────

export default defineConfig({
  projectRoot: '../immoui',
  rules: [
    // ── SDK hook pairs ──
    select('src/sdk/**/hooks/use-*.ts')
      .exclude(...MUTATION_PREFIXES.map((p) => `**/hooks/${p}*`))
      .label('SDK query hooks must export both useX and useSuspenseX')
      .category('structure')
      .check(
        requireExportPairs((name) => {
          if (!name.startsWith('use') || name.startsWith('useSuspense')) return null;
          return `useSuspense${name.slice(3)}`;
        }),
      ),

    select(...MUTATION_PREFIXES.map((p) => `src/sdk/**/hooks/${p}*.ts`))
      .label('SDK mutation hooks must not call useSuspenseQuery')
      .category('structure')
      .check(noFunctionCalls(['useSuspenseQuery'])),

    // ── SDK query options ──
    select('src/sdk/**/hooks/queries.ts')
      .label('queryOptions() calls must define queryKey, queryFn, and staleTime')
      .category('structure')
      .check(requireCallShape('queryOptions', ['queryKey', 'queryFn', 'staleTime'])),

    select('src/sdk/**/hooks/queries.ts')
      .label('SDK query files must export at least one key factory (xKeys)')
      .category('structure')
      .check(requireExportFactories({ pattern: /Keys$/, minCount: 1 })),

    // ── SDK mutation discipline ──
    select('src/sdk/**/hooks/use-{create,update,delete,move,duplicate,restore}-*.ts')
      .label('SDK mutation hooks must implement onMutate, onError, and onSettled lifecycle')
      .category('structure')
      .check(requireCallShape('useMutation', ['onMutate', 'onError', 'onSettled'])),

    // ── SDK sub-domain structure ──
    select('src/sdk/domains/*/index.ts')
      .label('SDK sub-domains must have required files: index, interface, http, memory, types, fakes')
      .category('structure')
      .check(requireDirectoryStructure(REQUIRED_SUBDOMAIN_FILES)),

    select('src/sdk/**/hooks/index.ts')
      .label('SDK hooks directories must have index.ts and queries.ts')
      .category('structure')
      .check(requireDirectoryStructure(REQUIRED_HOOKS_FILES)),

    select(
      'src/sdk/**/hooks/query-keys.ts',
      'src/sdk/**/hooks/query-options.ts',
      'src/sdk/**/hooks.ts',
    )
      .label('SDK hooks must not use legacy file names (query-keys.ts, query-options.ts, hooks.ts)')
      .category('cleanup')
      .check(forbidFile({ message: 'This file is a legacy pattern — rename to queries.ts in hooks/' })),

    // ── i18n ──
    select('src/**/*.tsx')
      .exclude('**/*.test.tsx', '**/*.stories.tsx')
      .label('No hardcoded user-visible strings in JSX — use the translation API')
      .category('react')
      .check(noHardcodedStrings()),

    // ── Type boundaries ──
    select('src/**/*.{ts,tsx}')
      .exclude('src/sdk/**')
      .label('Generated API types must not leak outside src/sdk/')
      .category('structure')
      .check(
        requireImportBoundary({
          source: /types\.gen/,
          allowedIn: 'src/sdk/**',
        }),
      ),

    // ── Component data fetching ──
    select('src/**/*.{ts,tsx}')
      .exclude(...ALLOWED_TANSTACK_PATTERNS)
      .label('Components must not import from @tanstack/react-query directly')
      .category('react')
      .check(
        noImportFrom('@tanstack/react-query', {
          message:
            'Use SDK hooks instead of importing from @tanstack/react-query directly. ' +
            'Only src/sdk/ files may use TanStack Query primitives.',
        }),
      ),

    select('src/components/**/*.{ts,tsx}')
      .exclude('**/*.stories.tsx', '**/*.test.tsx')
      .label('Components must not call useQuery or useSuspenseQuery directly')
      .category('react')
      .check(
        noFunctionCalls(['useQuery', 'useSuspenseQuery'], {
          message: (name) =>
            `Do not call ${name}() directly. Use named SDK hooks like useSuspenseEstate(id) instead.`,
        }),
      ),

    // ── Route discipline ──
    select('src/routes/**/*.tsx')
      .label('Route pages must not import raw UI primitives')
      .category('react')
      .check(
        noImportFrom(/^~\/components\/ui\//, {
          message: 'Route pages must not import UI primitives directly — use layout or domain components',
        }),
      ),

    select('src/routes/**/*.tsx')
      .label('Route pages must not define local helper components')
      .category('react')
      .check(noLocalFunctionComponents()),

    select('src/routes/**/*.tsx')
      .label('Route pages should not use useState — move state to domain components')
      .category('react')
      .check(
        noFunctionCalls(['useState'], {
          message: () =>
            'Route pages must be thin orchestrators — move state management to domain components',
        }),
      ),

    // ── Storybook ──
    select('src/components/{domains,generic,layout}/**/*.stories.{ts,tsx}')
      .label('Storybook stories must not define an explicit meta title — let Storybook derive from path')
      .category('cleanup')
      .check(
        noObjectProperty('meta', 'title', {
          message:
            "Remove 'title' from the meta object. " +
            'Storybook will derive the story group from the file path automatically.',
        }),
      ),

    // ── Test quality ──
    select('src/**/*.test.{ts,tsx}')
      .label('Test files must meet minimum quality score')
      .category('strictness')
      .check(
        requireMinTestScore({
          minScore: 50,
          assertionThresholds: [1, 3, 5, 8],
          assertionBonus: 5,
          testCountThresholds: [2, 4, 6],
          testCountBonus: 5,
          trivialAssertions: ['toBeTrue(', 'toBeTruthy(', 'toBeDefined('],
          trivialPenalty: -20,
          asyncIndicators: ['waitFor(', 'act('],
          interactionMethods: ['userEvent.', 'fireEvent.'],
          errorIndicators: ['.toThrow(', '.rejects.', 'toThrow('],
          asyncBonus: 5,
          interactionBonus: 5,
          errorBonus: 5,
          varietyBonus: 5,
        }),
      ),

    // ── Component coverage ──
    select('src/components/**/*.tsx')
      .exclude('**/*.test.tsx', '**/*.stories.tsx', '**/index.tsx')
      .label('All components need Storybook stories')
      .category('structure')
      .check(requireSibling('.stories.tsx')),

    select('src/components/**/*.tsx')
      .exclude('**/*.test.tsx', '**/*.stories.tsx', '**/index.tsx')
      .label('All components need test files')
      .category('structure')
      .check(requireSibling('.test.tsx')),

    // ── Architecture ──
    select('src/components/domains/*/')
      .label('Domain component directories must have an index.ts barrel')
      .category('structure')
      .check(requireChildren(['index.ts'])),

    select('src/components/domains/**/*.{ts,tsx}')
      .label('Components must not deep-import into other domain internals')
      .category('structure')
      .check(
        noCrossModuleImports({
          modulePattern: /src\/components\/domains\/([^/]+)\//,
          message: (from, to) =>
            `Domain '${from}' must not import directly into domain '${to}' internals. ` +
            `Import from the domain's index.ts instead.`,
        }),
      ),

    // ── Relative imports ──
    select('src/components/**/*.{ts,tsx}')
      .exclude('**/*.test.ts', '**/*.test.tsx')
      .label('All relative imports must resolve to existing files')
      .category('strictness')
      .check(relativeImports()),

    // ── External tools ──
    oxlint({
      pattern: 'src/',
      cwd: '../immoui',
      label: 'oxlint',
      category: 'strictness',
    }),

    oxfmt({
      pattern: 'src/**/*.{ts,tsx}',
      cwd: '../immoui',
      label: 'oxfmt',
      category: 'strictness',
    }),

    vitest({
      cwd: '../immoui',
      project: ['unit'],
      label: 'Vitest unit tests',
      category: 'strictness',
    }),

    storybook({
      url: 'http://localhost:6006',
      cwd: '../immoui',
      label: 'Storybook test runner',
      category: 'react',
    }),
  ],
});

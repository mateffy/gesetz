/**
 * The built-in rule catalog.
 *
 * Kept apart from `rules.ts` (the generator) so the data can be read and
 * reviewed on its own, and so the generator stays under the file line budget.
 */
import type { PresetId, ProjectProfile, ToolId } from './detect';

export interface GenerateContext {
  readonly profile: ProjectProfile;
  /** The set of tools the user selected (for adapter rule emission). */
  readonly tools: Set<ToolId>;
}

export interface RuleBlueprint {
  readonly id: string;
  readonly label: string;
  readonly category: string;
  readonly description: string;
  /**
   * If set, the blueprint only applies when the profile matches (e.g. storybook
   * blueprints require the storybook tool; route blueprints require routes/).
   */
  readonly appliesTo?: (ctx: GenerateContext) => boolean;
  /**
   * Returns the source string for this rule (a single `select(...)...` or
   * adapter call expression). May return null if `appliesTo` filters it out.
   */
  readonly emit: (ctx: GenerateContext) => string | null;
  /** Which preset sets include this blueprint by default. */
  readonly presets: ReadonlySet<PresetId>;
}

export interface Plan {
  readonly preset: PresetId;
  readonly tools: Set<ToolId>;
  readonly rules: Set<string>;
  readonly install: boolean;
  readonly qaScript: boolean;
  readonly profile: ProjectProfile;
}

// ─── Helper: import path per tool ─────────────────────────────────────────────

export const TOOL_IMPORT: Record<ToolId, string> = {
  oxlint: '@gesetz/oxlint',
  oxfmt: '@gesetz/oxfmt',
  prettier: '@gesetz/prettier',
  eslint: '@gesetz/eslint',
  vitest: '@gesetz/vitest',
  'bun-test': '@gesetz/bun-test',
  storybook: '@gesetz/storybook',
  phpstan: '@gesetz/phpstan',
  pest: '@gesetz/pest',
  phpunit: '@gesetz/phpunit',
};

export const TOOL_FN: Record<ToolId, string> = {
  oxlint: 'oxlint',
  oxfmt: 'oxfmt',
  prettier: 'prettier',
  eslint: 'eslint',
  vitest: 'vitest',
  'bun-test': 'bunTest',
  storybook: 'storybook',
  phpstan: 'phpstan',
  pest: 'pest',
  phpunit: 'phpunit',
};

/** The adapter rule expression for a tool. */
export function emitToolRule(tool: ToolId): string {
  switch (tool) {
    case 'oxlint':
      return "oxlint({ pattern: 'src/', label: 'oxlint', category: 'strictness' })";
    case 'oxfmt':
      return "oxfmt({ pattern: 'src/**/*.{ts,tsx}', label: 'oxfmt', category: 'strictness' })";
    case 'prettier':
      return "prettier({ pattern: 'src/**/*.{ts,tsx,js,jsx}', label: 'prettier', category: 'strictness' })";
    case 'eslint':
      return "eslint({ pattern: 'src/**/*.{ts,tsx}', label: 'eslint', category: 'strictness' })";
    case 'vitest':
      return "vitest({ label: 'Vitest', category: 'strictness' })";
    case 'bun-test':
      return "bunTest({ label: 'bun test', category: 'strictness' })";
    case 'storybook':
      return "storybook({ url: 'http://localhost:6006', label: 'Storybook', category: 'react' })";
    case 'phpstan':
      return "phpstan({ label: 'PHPStan', category: 'strictness' })";
    case 'pest':
      return "pest({ label: 'Pest', category: 'strictness' })";
    case 'phpunit':
      return "phpunit({ label: 'PHPUnit', category: 'strictness' })";
  }
}

// ─── Blueprint catalog ────────────────────────────────────────────────────────

const genericSet = new Set<PresetId>(['generic', 'react', 'tanstack-start']);
const reactSet = new Set<PresetId>(['react', 'tanstack-start']);
const tsSet = new Set<PresetId>(['tanstack-start']);
const laravelSet = new Set<PresetId>(['laravel']);

export const BLUEPRINTS: readonly RuleBlueprint[] = Object.freeze([
  // ── Generic (universal) ───────────────────────────────────────────────────
  {
    id: 'no-god-files',
    label: 'Files over 600 lines must be split',
    category: 'structure',
    description: 'Flag files exceeding 600 lines (god files).',
    presets: genericSet,
    emit: () => "select('src/**/*.{ts,tsx}').label('Files over 600 lines must be split').category('structure').check(noGodFile({ maxLines: 600 }))",
  },
  {
    id: 'no-console-log',
    label: 'No console.log in library code',
    category: 'cleanup',
    description: 'Ban console.log/debug/info from production source.',
    presets: genericSet,
    emit: () => "select('src/**/*.{ts,tsx}').exclude('**/*.test.ts').label('No console.log in library code').category('cleanup').check(noConsoleLog())",
  },
  {
    id: 'no-empty-catch',
    label: 'No empty catch blocks',
    category: 'strictness',
    description: 'Detect empty catch blocks that swallow errors.',
    presets: genericSet,
    emit: () => "select('src/**/*.{ts,tsx}').label('No empty catch blocks').category('strictness').check(noEmptyCatch())",
  },
  {
    id: 'no-trivial-comment',
    label: 'No trivial AI-narration comments',
    category: 'cleanup',
    description: 'Flag comments that just restate the code.',
    presets: genericSet,
    emit: () => "select('src/**/*.{ts,tsx}').label('No trivial AI-narration comments').category('cleanup').check(noTrivialComment())",
  },
  {
    id: 'no-hardcoded-secret',
    label: 'No hardcoded secrets',
    category: 'security',
    description: 'Detect common hardcoded secret patterns (api_key, token, etc).',
    presets: genericSet,
    emit: () => "select('src/**/*.{ts,tsx}').label('No hardcoded secrets').category('security').check(noHardcodedSecret())",
  },
  {
    id: 'no-debugging-residue',
    label: 'No debugging residue files',
    category: 'cleanup',
    description: 'Flag *_backup.ts, *_v2.ts, *_old.ts, etc.',
    presets: genericSet,
    emit: () => "select('src/**/*.{ts,tsx}').label('No debugging residue files').category('cleanup').check(noDebuggingResidueFiles())",
  },
  {
    id: 'relative-imports',
    label: 'Relative imports must resolve',
    category: 'strictness',
    description: 'All relative imports must point to existing files.',
    presets: genericSet,
    emit: () => "select('src/**/*.{ts,tsx}').exclude('**/*.test.ts', '**/*.test.tsx').label('Relative imports must resolve').category('strictness').check(relativeImports())",
  },
  {
    id: 'require-tests-sibling',
    label: 'Source files need test files',
    category: 'structure',
    description: 'Each *.ts/tsx needs a sibling *.test.ts/tsx.',
    presets: genericSet,
    appliesTo: (ctx) => ctx.profile.hasSrc,
    emit: () => "select('src/**/*.{ts,tsx}').exclude('**/*.test.ts', '**/*.test.tsx', '**/*.stories.tsx', '**/index.ts').label('Source files need test files').category('structure').check(requireSibling('.test.tsx'))",
  },
  {
    id: 'test-quality-score',
    label: 'Test files must meet minimum quality score',
    category: 'strictness',
    description: 'Score tests on assertions, interactions, async, error paths.',
    presets: genericSet,
    appliesTo: (ctx) => ctx.profile.hasSrc,
    emit: () => `select('src/**/*.test.{ts,tsx}').label('Test files must meet minimum quality score').category('strictness').check(
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
    )`,
  },

  // ── React-specific ─────────────────────────────────────────────────────────
  {
    id: 'no-hardcoded-strings',
    label: 'No hardcoded user-visible strings in JSX',
    category: 'react',
    description: 'Use the translation API instead of string literals in JSX.',
    presets: reactSet,
    appliesTo: (ctx) => ctx.profile.framework === 'react' || ctx.profile.framework === 'tanstack-start',
    emit: () => "select('src/**/*.tsx').exclude('**/*.test.tsx', '**/*.stories.tsx').label('No hardcoded user-visible strings in JSX').category('react').check(noHardcodedStrings())",
  },
  {
    id: 'component-has-stories',
    label: 'All components need Storybook stories',
    category: 'structure',
    description: 'Each component needs a sibling .stories.tsx.',
    presets: reactSet,
    appliesTo: (ctx) =>
      ctx.tools.has('storybook') &&
      (ctx.profile.framework === 'react' || ctx.profile.framework === 'tanstack-start'),
    emit: () => "select('src/components/**/*.tsx').exclude('**/*.test.tsx', '**/*.stories.tsx', '**/index.tsx').label('All components need Storybook stories').category('structure').check(requireSibling('.stories.tsx'))",
  },
  {
    id: 'component-has-tests',
    label: 'All components need test files',
    category: 'structure',
    description: 'Each component needs a sibling .test.tsx.',
    presets: reactSet,
    appliesTo: (ctx) => ctx.profile.hasComponents,
    emit: () => "select('src/components/**/*.tsx').exclude('**/*.test.tsx', '**/*.stories.tsx', '**/index.tsx').label('All components need test files').category('structure').check(requireSibling('.test.tsx'))",
  },
  {
    id: 'storybook-no-meta-title',
    label: 'Storybook stories must not define an explicit meta title',
    category: 'cleanup',
    description: 'Let Storybook derive the title from the file path.',
    presets: reactSet,
    appliesTo: (ctx) =>
      ctx.tools.has('storybook') &&
      (ctx.profile.framework === 'react' || ctx.profile.framework === 'tanstack-start'),
    emit: () => "select('src/components/**/*.stories.{ts,tsx}').label('Storybook stories must not define an explicit meta title').category('cleanup').check(noObjectProperty('meta', 'title', { message: \"Remove 'title' from the meta object. Storybook will derive the story group from the file path automatically.\" }))",
  },
  {
    id: 'no-direct-tanstack-query',
    label: 'Components must not import from @tanstack/react-query directly',
    category: 'react',
    description: 'Use SDK hooks instead of TanStack Query primitives.',
    presets: reactSet,
    appliesTo: (ctx) => ctx.profile.framework === 'tanstack-start',
    emit: () => `select('src/**/*.{ts,tsx}').exclude('src/sdk/**', 'src/router.tsx', 'src/**/__tests__/**', 'src/**/*.stories.tsx', 'src/**/*.test.tsx').label('Components must not import from @tanstack/react-query directly').category('react').check(
      noImportFrom('@tanstack/react-query', {
        message: 'Use SDK hooks instead of importing from @tanstack/react-query directly. Only src/sdk/ files may use TanStack Query primitives.',
      }),
    )`,
  },

  // ── TanStack Start route discipline ─────────────────────────────────────────
  {
    id: 'route-no-ui-imports',
    label: 'Route pages must not import raw UI primitives',
    category: 'react',
    description: 'Route pages should use layout or domain components.',
    presets: tsSet,
    appliesTo: (ctx) => ctx.profile.hasRoutes,
    emit: () => "select('src/routes/**/*.tsx').label('Route pages must not import raw UI primitives').category('react').check(noImportFrom(/^~\\/components\\/ui\\//, { message: 'Route pages must not import UI primitives directly \u2014 use layout or domain components' }))",
  },
  {
    id: 'route-no-local-components',
    label: 'Route pages must not define local helper components',
    category: 'react',
    description: 'Routes should be thin orchestrators.',
    presets: tsSet,
    appliesTo: (ctx) => ctx.profile.hasRoutes,
    emit: () => "select('src/routes/**/*.tsx').label('Route pages must not define local helper components').category('react').check(noLocalFunctionComponents())",
  },
  {
    id: 'route-no-usestate',
    label: 'Route pages should not use useState',
    category: 'react',
    description: 'Move state to domain components.',
    presets: tsSet,
    appliesTo: (ctx) => ctx.profile.hasRoutes,
    emit: () => "select('src/routes/**/*.tsx').label('Route pages should not use useState \u2014 move state to domain components').category('react').check(noFunctionCalls(['useState'], { message: () => 'Route pages must be thin orchestrators \u2014 move state management to domain components' }))",
  },
  {
    id: 'domain-isolation',
    label: 'Components must not deep-import into other domain internals',
    category: 'structure',
    description: 'Import from a domain index.ts, not its internals.',
    presets: tsSet,
    appliesTo: (ctx) => ctx.profile.hasDomains,
    emit: () => `select('src/components/domains/**/*.{ts,tsx}').label('Components must not deep-import into other domain internals').category('structure').check(
      noCrossModuleImports({
        modulePattern: /src\\/components\\/domains\\/([^/]+)\\//,
        message: (from: string, to: string) => \`Domain '\${from}' must not import directly into domain '\${to}' internals. Import from the domain's index.ts instead.\`,
      }),
    )`,
  },
  {
    id: 'domain-barrel',
    label: 'Domain component directories must have an index.ts barrel',
    category: 'structure',
    description: 'Each domain dir needs an index.ts.',
    presets: tsSet,
    appliesTo: (ctx) => ctx.profile.hasDomains,
    emit: () => "select('src/components/domains/*/').label('Domain component directories must have an index.ts barrel').category('structure').check(requireChildren(['index.ts']))",
  },

  // ── Laravel / PHP ──────────────────────────────────────────────────────────
  {
    id: 'laravel-strict-types',
    label: 'All PHP files must declare strict_types=1',
    category: 'strictness',
    description: 'Missing declare(strict_types=1) weakens type guarantees.',
    presets: laravelSet,
    appliesTo: (ctx) => ctx.profile.isLaravel,
    emit: () => 'requireStrictTypes',
  },
  {
    id: 'laravel-psr-namespaces',
    label: 'PHP namespaces must follow PSR-4 conventions',
    category: 'organization',
    description: 'App\\ \u2192 app/, PSR-4 discipline.',
    presets: laravelSet,
    appliesTo: (ctx) => ctx.profile.isLaravel,
    emit: () => 'requirePsrNamespaces',
  },
  {
    id: 'laravel-no-raw-db',
    label: 'No raw SQL via the DB facade',
    category: 'security',
    description: 'Encourages Eloquent over raw, injection-prone queries.',
    presets: laravelSet,
    appliesTo: (ctx) => ctx.profile.isLaravel,
    emit: () => 'noRawDbQueries',
  },
  {
    id: 'laravel-no-env-outside-config',
    label: 'env() may only be called from config files',
    category: 'security',
    description: 'env() outside config/ breaks config caching.',
    presets: laravelSet,
    appliesTo: (ctx) => ctx.profile.isLaravel,
    emit: () => 'noEnvOutsideConfig',
  },
  {
    id: 'laravel-no-debug-helpers',
    label: 'No dd()/dump()/ray() debug helpers in committed code',
    category: 'cleanup',
    description: 'Debug helpers should not ship to production.',
    presets: laravelSet,
    appliesTo: (ctx) => ctx.profile.isLaravel,
    emit: () => 'noDebugHelpers',
  },
]);

/** Look up a blueprint by id. */

// ─── Accessors ────────────────────────────────────────────────────────────────

export function getBlueprint(id: string): RuleBlueprint | undefined {
  return BLUEPRINTS.find((b) => b.id === id);
}

export function blueprintsForPreset(preset: PresetId): RuleBlueprint[] {
  return BLUEPRINTS.filter((b) => b.presets.has(preset));
}

export function toolsForPreset(preset: PresetId): ToolId[] {
  switch (preset) {
    case 'laravel':
      return ['phpstan', 'pest', 'phpunit'];
    case 'tanstack-start':
    case 'react':
      return ['oxlint', 'oxfmt', 'vitest', 'storybook'];
    case 'generic':
      return ['oxlint', 'oxfmt', 'vitest'];
    case 'blank':
      return [];
  }
}

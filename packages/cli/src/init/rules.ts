/**
 * Rule blueprint catalog & config generator.
 *
 * Each `RuleBlueprint` has an `id`, human metadata, an `appliesTo` predicate,
 * and an `emit(ctx)` that returns the source-string for that rule. The
 * generator assembles imports (deduped) + grouped rule expressions into a
 * valid `regel.config.ts` file. Pure functions — no Effect, no adapter imports
 * at generate-time (we emit strings only).
 */
import type { PresetId, ProjectProfile, ToolId } from './detect';

// ─── Types ────────────────────────────────────────────────────────────────────

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

const TOOL_IMPORT: Record<ToolId, string> = {
  oxlint: '@regeln/oxlint',
  oxfmt: '@regeln/oxfmt',
  prettier: '@regeln/prettier',
  eslint: '@regeln/eslint',
  vitest: '@regeln/vitest',
  'bun-test': '@regeln/bun-test',
  storybook: '@regeln/storybook',
  phpstan: '@regeln/phpstan',
  pest: '@regeln/pest',
  phpunit: '@regeln/phpunit',
};

const TOOL_FN: Record<ToolId, string> = {
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
function emitToolRule(tool: ToolId): string {
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
export function getBlueprint(id: string): RuleBlueprint | undefined {
  return BLUEPRINTS.find((b) => b.id === id);
}

/** Blueprints that belong to a preset by default. */
export function blueprintsForPreset(preset: PresetId): RuleBlueprint[] {
  return BLUEPRINTS.filter((b) => b.presets.has(preset));
}

/** Tool ids that should be suggested given a preset + detected tools. */
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

// ─── Generator ────────────────────────────────────────────────────────────────

/**
 * Which imports each blueprint needs. Keyed by blueprint id → list of
 * `{ from, name }` import specifiers.
 */
interface ImportSpec {
  readonly from: string;
  readonly name: string;
}

const BLUEPRINT_IMPORTS: Record<string, ImportSpec[]> = {
  'no-god-files': [{ from: '@regeln/core', name: 'noGodFile' }],
  'no-console-log': [{ from: '@regeln/core', name: 'noConsoleLog' }],
  'no-empty-catch': [{ from: '@regeln/core', name: 'noEmptyCatch' }],
  'no-trivial-comment': [{ from: '@regeln/core', name: 'noTrivialComment' }],
  'no-hardcoded-secret': [{ from: '@regeln/core', name: 'noHardcodedSecret' }],
  'no-debugging-residue': [{ from: '@regeln/core', name: 'noDebuggingResidueFiles' }],
  'relative-imports': [{ from: '@regeln/core', name: 'relativeImports' }],
  'require-tests-sibling': [
    { from: '@regeln/core', name: 'requireSibling' },
  ],
  'test-quality-score': [{ from: '@regeln/typescript', name: 'requireMinTestScore' }],
  'no-hardcoded-strings': [{ from: '@regeln/typescript', name: 'noHardcodedStrings' }],
  'component-has-stories': [{ from: '@regeln/core', name: 'requireSibling' }],
  'component-has-tests': [{ from: '@regeln/core', name: 'requireSibling' }],
  'storybook-no-meta-title': [{ from: '@regeln/typescript', name: 'noObjectProperty' }],
  'no-direct-tanstack-query': [{ from: '@regeln/core', name: 'noImportFrom' }],
  'route-no-ui-imports': [{ from: '@regeln/core', name: 'noImportFrom' }],
  'route-no-local-components': [{ from: '@regeln/typescript', name: 'noLocalFunctionComponents' }],
  'route-no-usestate': [{ from: '@regeln/typescript', name: 'noFunctionCalls' }],
  'domain-isolation': [{ from: '@regeln/typescript', name: 'noCrossModuleImports' }],
  'domain-barrel': [{ from: '@regeln/core', name: 'requireChildren' }],
};

const LARAVEL_RULE_BLUEPRINT_IDS = [
  'laravel-strict-types',
  'laravel-psr-namespaces',
  'laravel-no-raw-db',
  'laravel-no-env-outside-config',
  'laravel-no-debug-helpers',
];

/**
 * Assemble the `regel.config.ts` source string from a Plan.
 *
 * - Dedupes imports from all selected blueprints + tools.
 * - Groups rule expressions by category (as comments).
 * - Laravel rules are emitted as bare identifiers (imported from @regeln/laravel).
 */
export function generateConfig(plan: Plan): string {
  const ctx: GenerateContext = { profile: plan.profile, tools: plan.tools };
  const isLaravel = plan.preset === 'laravel';

  // Resolve which blueprints to emit (respecting appliesTo).
  const emittedBlueprints: RuleBlueprint[] = [];
  const ruleExprs: string[] = [];

  if (!isLaravel) {
    for (const id of plan.rules) {
      const bp = getBlueprint(id);
      if (!bp) continue;
      // For laravel- prefixed blueprints, skip in non-laravel presets.
      if (id.startsWith('laravel-')) continue;
      if (bp.appliesTo && !bp.appliesTo(ctx)) continue;
      const expr = bp.emit(ctx);
      if (expr) {
        emittedBlueprints.push(bp);
        ruleExprs.push(expr);
      }
    }
  } else {
    // Laravel: emit the laravel- prefixed blueprints as bare identifiers.
    for (const id of plan.rules) {
      if (!id.startsWith('laravel-')) continue;
      const bp = getBlueprint(id);
      if (!bp) continue;
      if (bp.appliesTo && !bp.appliesTo(ctx)) continue;
      const expr = bp.emit(ctx);
      if (expr) {
        emittedBlueprints.push(bp);
        ruleExprs.push(expr);
      }
    }
  }

  // Tool adapter rules.
  const toolExprs: string[] = [];
  for (const tool of plan.tools) {
    if (isLaravel && (tool === 'phpstan' || tool === 'pest' || tool === 'phpunit')) {
      toolExprs.push(emitToolRule(tool));
    } else if (!isLaravel) {
      toolExprs.push(emitToolRule(tool));
    }
  }

  // ── Build imports (deduped) ──
  // Always import defineConfig + select from core.
  const imports = new Map<string, Set<string>>(); // from -> set of names
  const addImport = (from: string, name: string) => {
    let set = imports.get(from);
    if (!set) {
      set = new Set();
      imports.set(from, set);
    }
    set.add(name);
  };

  addImport('@regeln/core', 'defineConfig');
  if (!isLaravel) addImport('@regeln/core', 'select');

  // Blueprint imports.
  for (const bp of emittedBlueprints) {
    const specs = BLUEPRINT_IMPORTS[bp.id];
    if (specs) for (const s of specs) addImport(s.from, s.name);
  }

  // Laravel rule imports.
  if (isLaravel && emittedBlueprints.some((b) => LARAVEL_RULE_BLUEPRINT_IDS.includes(b.id))) {
    addImport('@regeln/laravel', 'requireStrictTypes');
    addImport('@regeln/laravel', 'requirePsrNamespaces');
    addImport('@regeln/laravel', 'noRawDbQueries');
    addImport('@regeln/laravel', 'noEnvOutsideConfig');
    addImport('@regeln/laravel', 'noDebugHelpers');
  }

  // Tool imports.
  for (const tool of plan.tools) {
    const from = TOOL_IMPORT[tool];
    const fn = TOOL_FN[tool];
    if (isLaravel && tool !== 'phpstan' && tool !== 'pest' && tool !== 'phpunit') continue;
    addImport(from, fn);
  }

  // ── Render imports ──
  const importLines: string[] = [];
  for (const [from, names] of imports) {
    const sorted = [...names].sort();
    importLines.push(`import { ${sorted.join(', ')} } from '${from}';`);
  }

  // ── Render rules array ──
  const allRules = [...ruleExprs, ...toolExprs];
  const rulesBlock =
    allRules.length === 0
      ? '  rules: [],'
      : '  rules: [\n' +
        allRules.map((r) => `    ${r},`).join('\n') +
        '\n  ],';

  // ── Compose file ──
  const header = `/**
 * regel config — generated by \`regel init\`.
 *
 * Run with:  regel check
 * Edit freely; re-run \`regel init --force\` to regenerate from scratch.
 */
`;

  const body = `export default defineConfig({
  projectRoot: import.meta.dirname,
${rulesBlock}
});
`;

  return header + '\n' + importLines.join('\n') + '\n\n' + body;
}

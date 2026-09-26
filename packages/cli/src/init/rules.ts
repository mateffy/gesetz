/**
 * Rule blueprint catalog & config generator.
 *
 * Each `RuleBlueprint` has an `id`, human metadata, an `appliesTo` predicate,
 * and an `emit(ctx)` that returns the source-string for that rule. The
 * generator assembles imports (deduped) + grouped rule expressions into a
 * valid `gesetz.config.ts` file. Pure functions — no Effect, no adapter imports
 * at generate-time (we emit strings only).
 */

import { TOOL_FN, TOOL_IMPORT, emitToolRule, getBlueprint } from './blueprints';
import type { GenerateContext, Plan, RuleBlueprint } from './blueprints';

export { BLUEPRINTS, blueprintsForPreset, getBlueprint, toolsForPreset } from './blueprints';
export type { GenerateContext, Plan, RuleBlueprint } from './blueprints';

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
  'no-god-files': [{ from: '@gesetz/core', name: 'noGodFile' }],
  // Moved to @gesetz/typescript; @gesetz/core no longer exports them, and a
  // generated config that imported them from there would not compile.
  'no-console-log': [{ from: '@gesetz/typescript', name: 'noConsoleLog' }],
  'no-empty-catch': [{ from: '@gesetz/typescript', name: 'noEmptyCatch' }],
  'no-trivial-comment': [{ from: '@gesetz/typescript', name: 'noTrivialComment' }],
  'no-hardcoded-secret': [{ from: '@gesetz/core', name: 'noHardcodedSecret' }],
  'no-debugging-residue': [{ from: '@gesetz/core', name: 'noDebuggingResidueFiles' }],
  'relative-imports': [{ from: '@gesetz/typescript', name: 'relativeImports' }],
  'require-tests-sibling': [
    { from: '@gesetz/core', name: 'requireSibling' },
  ],
  'test-quality-score': [{ from: '@gesetz/typescript', name: 'requireMinTestScore' }],
  'no-hardcoded-strings': [{ from: '@gesetz/typescript', name: 'noHardcodedStrings' }],
  'component-has-stories': [{ from: '@gesetz/core', name: 'requireSibling' }],
  'component-has-tests': [{ from: '@gesetz/core', name: 'requireSibling' }],
  'storybook-no-meta-title': [{ from: '@gesetz/typescript', name: 'noObjectProperty' }],
  'no-direct-tanstack-query': [{ from: '@gesetz/core', name: 'noImportFrom' }],
  'route-no-ui-imports': [{ from: '@gesetz/core', name: 'noImportFrom' }],
  'route-no-local-components': [{ from: '@gesetz/typescript', name: 'noLocalFunctionComponents' }],
  'route-no-usestate': [{ from: '@gesetz/typescript', name: 'noFunctionCalls' }],
  'domain-isolation': [{ from: '@gesetz/typescript', name: 'noCrossModuleImports' }],
  'domain-barrel': [{ from: '@gesetz/core', name: 'requireChildren' }],
};

const LARAVEL_RULE_BLUEPRINT_IDS = new Set([
  'laravel-strict-types',
  'laravel-psr-namespaces',
  'laravel-no-raw-db',
  'laravel-no-env-outside-config',
  'laravel-no-debug-helpers',
]);

/**
 * Assemble the `gesetz.config.ts` source string from a Plan.
 *
 * - Dedupes imports from all selected blueprints + tools.
 * - Groups rule expressions by category (as comments).
 * - Laravel rules are emitted as bare identifiers (imported from @gesetz/laravel).
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

  addImport('@gesetz/core', 'defineConfig');
  if (!isLaravel) addImport('@gesetz/core', 'select');

  // Blueprint imports.
  for (const bp of emittedBlueprints) {
    const specs = BLUEPRINT_IMPORTS[bp.id];
    if (specs) for (const s of specs) addImport(s.from, s.name);
  }

  // Laravel rule imports.
  if (isLaravel && emittedBlueprints.some((b) => LARAVEL_RULE_BLUEPRINT_IDS.has(b.id))) {
    addImport('@gesetz/laravel', 'requireStrictTypes');
    addImport('@gesetz/laravel', 'requirePsrNamespaces');
    addImport('@gesetz/laravel', 'noRawDbQueries');
    addImport('@gesetz/laravel', 'noEnvOutsideConfig');
    addImport('@gesetz/laravel', 'noDebugHelpers');
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
 * gesetz config — generated by \`gesetz init\`.
 *
 * Run with:  gesetz check
 * Edit freely; re-run \`gesetz init --force\` to regenerate from scratch.
 */
`;

  const body = `export default defineConfig({
  projectRoot: import.meta.dirname,
${rulesBlock}
});
`;

  return header + '\n' + importLines.join('\n') + '\n\n' + body;
}

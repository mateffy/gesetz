import { Effect } from 'effect';
import { FileSystem } from '../services/fs';
import type { Rule, Violation } from '../engine/rule';
import type { TsAdapter } from '../services/ts-adapter';
import type { PhpAdapter } from '../services/php-adapter';

/** Subset of dependency-cruiser's `ICruiseResult` that we read. */
interface CruiseResult {
  readonly output: {
    readonly modules: ReadonlyArray<{
      readonly source: string;
      readonly dependencies: ReadonlyArray<{
        readonly resolved: string;
        readonly circular: boolean;
      }>;
    }>;
  };
}

/**
 * Minimal typed view of the dependency-cruiser module's `cruise` export.
 * Defined locally so this file compiles without the optional peer dep
 * installed; the cast to this interface happens at the single import site.
 */
interface DependencyCruiserModule {
  readonly cruise: (
    patterns: string[],
    options: Record<string, unknown>,
    resolveOptions: { cwd: string },
  ) => CruiseResult;
}

export interface NoCyclesOptions {
  cwd?: string;
  tsConfigPath?: string;
  label?: string;
  id?: string;
}

/**
 * Creates a Rule that checks for circular dependencies using dependency-cruiser.
 * Requires `dependency-cruiser` to be installed as a peer dependency.
 *
 * @example
 * noCycles('src/**\/*.{ts,tsx}', { label: 'No circular dependencies' })
 */
export function noCycles(pattern: string | string[], opts: NoCyclesOptions = {}): Rule {
  const id = opts.id ?? 'no-cycles';
  const description = opts.label ?? 'No circular dependencies';
  const cwd = opts.cwd ?? process.cwd();
  const patterns = Array.isArray(pattern) ? pattern : [pattern];

  const run: Rule['run'] = Effect.gen(function* () {
    // dependency-cruiser is an optional peer dep — degrade gracefully.
    const raw = yield* Effect.tryPromise({
      try: async () =>
        // @ts-ignore — dependency-cruiser is an optional peer dep; present in
        // some workspaces, absent in others. Cast to DependencyCruiserModule.
        (await import('dependency-cruiser')) as unknown as DependencyCruiserModule,
      catch: () => null,
    }).pipe(Effect.catchAll(() => Effect.succeed(null)));

    if (raw === null || typeof raw.cruise !== 'function') {
      yield* Effect.logWarning(
        '[gesetz] dependency-cruiser is not installed or export shape changed — noCycles() produced no violations.',
      );
      return [];
    }
    const cruiser = raw;

    const result = yield* Effect.try({
      try: () =>
        cruiser.cruise(
          patterns,
          {
            ruleSet: {
              forbidden: [
                {
                  name: 'no-circular',
                  severity: 'error',
                  from: {},
                  to: { circular: true },
                },
              ],
            },
            tsPreCompilationDeps: true,
            ...(opts.tsConfigPath ? { tsConfig: { fileName: opts.tsConfigPath } } : {}),
          },
          { cwd },
        ),
      catch: () => null,
    }).pipe(Effect.catchAll(() => Effect.succeed(null)));

    if (result === null) {
      yield* Effect.logWarning(
        '[gesetz] dependency-cruiser cruise() failed — noCycles() produced no violations.',
      );
      return [];
    }

    const violations: Violation[] = [];
    for (const mod of result.output.modules) {
      for (const dep of mod.dependencies) {
        if (dep.circular) {
          violations.push({
            rule: id,
            message: `Circular dependency: ${mod.source} \u2192 ${dep.resolved}`,
            path: mod.source,
            severity: 'error',
            source: 'custom',
          });
        }
      }
    }

    return violations;
  });

  return { id, description, run };
}

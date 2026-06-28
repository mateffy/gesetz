import { Effect } from 'effect';
import { SyntaxTree } from '@gesetz/core';
import type { Check, Violation } from '@gesetz/core';

/**
 * For every exported function/variable named `X`, checks that ALL counterparts
 * returned by `getRelated(X)` are also exported from the same file.
 * Return `null` from `getRelated` to skip that export.
 *
 * Renamed from `requireExportPairs` — now N-ary (returns `string[] | null`).
 *
 * Uses the `SyntaxTree` service (oxc-parser exports) — no ts-morph.
 *
 * @example
 * // Every useX hook must have both useSuspenseX and useCachedX counterparts
 * requireRelatedExports(name => {
 *   if (!name.startsWith('use')) return null
 *   const base = name.slice(3)
 *   return [`useSuspense${base}`, `useCached${base}`]
 * })
 */
export function requireRelatedExports(
  getRelated: (name: string) => string[] | null,
  opts: { message?: (name: string, missing: readonly string[]) => string } = {},
): Check {
  return (file) =>
    Effect.gen(function* () {
      const st = yield* SyntaxTree;
      if (!st.canProcess(file)) return [];

      const result = yield* st.process(file, { exports: true }).pipe(
        Effect.catchAll(() => Effect.succeed({ imports: [], calls: [], exports: [], structure: [] })),
      );
      const exportNames = new Set(result.exports.map((e) => e.name));
      const violations: Violation[] = [];

      for (const exp of result.exports) {
        const required = getRelated(exp.name);
        if (required === null) continue;
        const missing = required.filter((r) => !exportNames.has(r));
        if (missing.length > 0) {
          violations.push({
            rule: '',
            severity: 'error',
            source: 'core',
            message:
              opts.message?.(exp.name, missing) ??
              `Export '${exp.name}' requires related exports: ${missing.join(', ')}`,
            path: file.path,
          });
        }
      }

      return violations;
    });
}

/**
 * Checks that the file exports at least `minCount` identifiers whose names
 * match the given pattern.
 *
 * Renamed from `requireExportFactories` — signature now takes `pattern` and
 * `minCount` as positional parameters.
 *
 * Uses the `SyntaxTree` service (oxc-parser exports) — no ts-morph.
 *
 * @example
 * // At least one export named *Keys must exist
 * requireExportsMatching(/Keys$/, 1)
 */
export function requireExportsMatching(
  pattern: RegExp,
  minCount: number = 1,
  opts: { message?: string } = {},
): Check {
  return (file) =>
    Effect.gen(function* () {
      const st = yield* SyntaxTree;
      if (!st.canProcess(file)) return [];

      const result = yield* st.process(file, { exports: true }).pipe(
        Effect.catchAll(() => Effect.succeed({ imports: [], calls: [], exports: [], structure: [] })),
      );
      const count = result.exports.filter((e) => pattern.test(e.name)).length;
      if (count >= minCount) return [];

      return [
        {
          rule: '',
          severity: 'error' as const,
          source: 'core' as const,
          message:
            opts.message ??
            `Expected at least ${minCount} export(s) matching ${pattern.source}, found ${count}`,
          path: file.path,
        },
      ];
    });
}

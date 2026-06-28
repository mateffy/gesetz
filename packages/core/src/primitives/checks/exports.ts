import { Effect } from 'effect';
import { SyntaxTree } from '../../services/syntax-tree';
import type { Check, Violation } from '../../engine/rule';

export interface RequireExportsMatchingOptions {
  readonly message?: string;
  readonly severity?: Violation['severity'];
}

/**
 * Checks that the file exports at least `minCount` identifiers whose names
 * match the given pattern. Uses `SyntaxTree.extractExports`.
 *
 * @example
 * // At least one export named *Keys must exist
 * requireExportsMatching(/Keys$/, 1)
 */
export function requireExportsMatching(
  pattern: RegExp,
  minCount: number = 1,
  opts: RequireExportsMatchingOptions = {},
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
          severity: opts.severity ?? 'error',
          source: 'core',
          message:
            opts.message ??
            `Expected at least ${minCount} export(s) matching ${pattern}, found ${count}`,
          path: file.path,
        },
      ];
    });
}

export interface RequireRelatedExportsOptions {
  readonly message?: (name: string, missing: readonly string[]) => string;
  readonly severity?: Violation['severity'];
}

/**
 * For every exported identifier `X`, checks that ALL counterparts returned by
 * `getRelated(X)` are also exported from the same file. Return `null` from
 * `getRelated` to skip that export.
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
  opts: RequireRelatedExportsOptions = {},
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
        if (required === null) continue; // skip this export

        const missing = required.filter((r) => !exportNames.has(r));
        if (missing.length > 0) {
          violations.push({
            rule: '',
            severity: opts.severity ?? 'error',
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

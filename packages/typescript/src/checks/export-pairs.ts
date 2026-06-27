import { Effect } from 'effect';
import type { Check, Violation } from '@regeln/core';
import type { SourceFile } from 'ts-morph';
import { loadSourceFile } from './shared';

/**
 * For every exported function/variable named `X`, checks that a counterpart
 * `getCounterpart(X)` is also exported from the same file.
 * Return `null` from `getCounterpart` to skip that export.
 *
 * @example
 * // Every useX hook must have a useSuspenseX counterpart
 * requireExportPairs(name => name.startsWith('use') ? `useSuspense${name.slice(3)}` : null)
 */
export function requireExportPairs(
  getCounterpart: (name: string) => string | null,
  opts: { tsConfigPath?: string; message?: (name: string, counterpart: string) => string } = {},
): Check {
  return (file) =>
    Effect.gen(function* () {
      const sourceFile = yield* loadSourceFile(file.absolutePath, opts.tsConfigPath);

      if (sourceFile === null) return [];

      const sf = sourceFile._tsMorph as SourceFile;
      const exports = new Set<string>();

      // Collect all exported identifiers
      for (const decl of sf.getExportedDeclarations()) {
        const [name] = decl;
        if (typeof name === 'string') exports.add(name);
      }

      const violations: Violation[] = [];

      for (const name of exports) {
        const counterpart = getCounterpart(name);
        if (counterpart === null) continue;
        if (!exports.has(counterpart)) {
          violations.push({
            rule: '',
            severity: 'error',
            source: 'core',
            message:
              opts.message?.(name, counterpart) ??
              `Export '${name}' requires counterpart '${counterpart}' to also be exported`,
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
 * @example
 * // At least one export named *Keys must exist
 * requireExportFactories({ pattern: /Keys$/, minCount: 1 })
 */
export function requireExportFactories(
  opts: {
    pattern: RegExp;
    minCount?: number;
    tsConfigPath?: string;
    message?: string;
  },
): Check {
  const minCount = opts.minCount ?? 1;

  return (file) =>
    Effect.gen(function* () {
      const sourceFile = yield* loadSourceFile(file.absolutePath, opts.tsConfigPath);

      if (sourceFile === null) return [];

      const sf = sourceFile._tsMorph as SourceFile;
      let count = 0;

      for (const [name] of sf.getExportedDeclarations()) {
        if (typeof name === 'string' && opts.pattern.test(name)) count++;
      }

      if (count >= minCount) return [];

      return [
        {
          rule: '',
          severity: 'error' as const,
          source: 'core' as const,
          message:
            opts.message ??
            `Expected at least ${minCount} export(s) matching ${opts.pattern.source}, found ${count}`,
          path: file.path,
        },
      ];
    });
}

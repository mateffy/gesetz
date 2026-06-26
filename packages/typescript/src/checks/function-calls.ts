import { Effect } from 'effect';
import type { Check, Violation } from '@regeln/core';
import type { CallExpression } from 'ts-morph';
import { loadSourceFile } from './shared';

/**
 * Checks that none of the listed function names are called in the file.
 *
 * @example
 * // Components must not call useQuery directly
 * noFunctionCalls(['useQuery', 'useSuspenseQuery'])
 */
export function noFunctionCalls(
  callNames: string[],
  opts: {
    tsConfigPath?: string;
    message?: (name: string) => string;
  } = {},
): Check {
  return (file) =>
    Effect.gen(function* () {
      const sourceFile = yield* loadSourceFile(file.absolutePath, opts.tsConfigPath);

      if (sourceFile === null) return [];

      const sf = sourceFile._tsMorph;
      const violations: Violation[] = [];
      const nameSet = new Set(callNames);

      const calls: readonly CallExpression[] = sf.getDescendantsOfKind?.(200 /* CallExpression */) ?? [];

      for (const call of calls) {
        const expr = call.getExpression?.();
        if (!expr) continue;
        const callName = expr.getText?.();
        if (typeof callName === 'string' && nameSet.has(callName)) {
          violations.push({
            rule: '',
            severity: 'error',
            source: 'core',
            message: opts.message?.(callName) ?? `Forbidden function call: ${callName}()`,
            path: file.path,
            line: call.getStartLineNumber?.(),
          });
        }
      }

      return violations;
    });
}

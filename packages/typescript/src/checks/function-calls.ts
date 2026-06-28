import { Effect } from 'effect';
import type { Check, Violation } from '@gesetz/core';
import { parseFile, findByKind, startLine } from './shared';

/**
 * Checks that none of the listed function names are called in the file.
 *
 * Implemented with ast-grep (syntactic). Replaces the ts-morph version.
 *
 * @example
 * // Components must not call useQuery directly
 * noFunctionCalls(['useQuery', 'useSuspenseQuery'])
 */
export function noFunctionCalls(
  callNames: string[],
  opts: {
    readonly message?: (name: string) => string;
  } = {},
): Check {
  const nameSet = new Set(callNames);

  return (file) =>
    Effect.sync(() => {
      const root = parseFile(file.content, file.path);
      if (root === null) return [];

      const violations: Violation[] = [];
      const calls = findByKind(root, 'call_expression');

      for (const call of calls) {
        const callName = call.child(0)?.text() ?? '';
        if (nameSet.has(callName)) {
          violations.push({
            rule: '',
            severity: 'error',
            source: 'core',
            message: opts.message?.(callName) ?? `Forbidden function call: ${callName}()`,
            path: file.path,
            line: startLine(call),
          });
        }
      }

      return violations;
    });
}

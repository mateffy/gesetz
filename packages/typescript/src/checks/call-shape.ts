import { Effect } from 'effect';
import type { Check, Violation } from '@regeln/core';
import { SyntaxKind } from 'ts-morph';
import type { CallExpression, ObjectLiteralExpression, PropertyAssignment, SourceFile } from 'ts-morph';
import { loadSourceFile } from './shared';

/**
 * Checks that every call to `fnName()` in the file passes an object literal
 * containing all `requiredKeys`.
 *
 * @example
 * // queryOptions() must define queryKey, queryFn, and staleTime
 * requireCallShape('queryOptions', ['queryKey', 'queryFn', 'staleTime'])
 */
export function requireCallShape(
  fnName: string,
  requiredKeys: string[],
  opts: {
    tsConfigPath?: string;
    message?: (missing: string[]) => string;
  } = {},
): Check {
  return (file) =>
    Effect.gen(function* () {
      const sourceFile = yield* loadSourceFile(file.absolutePath, opts.tsConfigPath);

      if (sourceFile === null) return [];

      const sf = sourceFile._tsMorph as SourceFile;
      const violations: Violation[] = [];

      const calls: readonly CallExpression[] = sf.getDescendantsOfKind
        ? sf.getDescendantsOfKind(SyntaxKind.CallExpression)
        : [];

      for (const call of calls) {
        // Check if this is a call to fnName
        const expr = call.getExpression?.();
        if (!expr) continue;
        const callName = expr.getText?.();
        if (callName !== fnName) continue;

        // Find the first object literal argument
        const args = call.getArguments?.() ?? [];
        const objArg = args.find(
          (a): a is ObjectLiteralExpression => a.getKind?.() === 204, /* ObjectLiteralExpression */
        );
        if (objArg === undefined) {
          violations.push({
            rule: '',
            severity: 'error',
            source: 'core',
            message: `${fnName}() must be called with an object literal argument`,
            path: file.path,
            line: call.getStartLineNumber?.(),
          });
          continue;
        }

        // Check required keys
        const props = new Set<string>(
          (objArg.getProperties?.() ?? [])
            .filter((p): p is PropertyAssignment => p.getKind?.() === 290) /* PropertyAssignment */
            .map((p) => p.getName?.() ?? '')
            .filter(Boolean),
        );
        const missing = requiredKeys.filter((k) => !props.has(k));

        if (missing.length > 0) {
          violations.push({
            rule: '',
            severity: 'error',
            source: 'core',
            message:
              opts.message?.(missing) ??
              `${fnName}() is missing required properties: ${missing.join(', ')}`,
            path: file.path,
            line: call.getStartLineNumber?.(),
          });
        }
      }

      return violations;
    });
}

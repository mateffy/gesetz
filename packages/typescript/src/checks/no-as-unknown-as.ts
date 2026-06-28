import { Effect } from 'effect';
import type { Check, Violation } from '@gesetz/core';
import { parseFile, findByKind, startLine } from './shared';

export interface NoAsUnknownAsOptions {
  readonly message?: string;
}

/**
 * Bans double-cast patterns `as unknown as X` (and `as any as X`), which
 * bypass the type system entirely. Extract a proper type guard instead.
 *
 * Implemented with ast-grep (syntactic).
 *
 * @example
 * select('src/**\/*.{ts,tsx}').check(noAsUnknownAs())
 */
export function noAsUnknownAs(opts: NoAsUnknownAsOptions = {}): Check {
  return (file) =>
    Effect.sync(() => {
      const root = parseFile(file.content, file.path);
      if (root === null) return [];

      const violations: Violation[] = [];
      // An `as unknown as X` is an `as_expression` whose first child is
      // itself an `as_expression` whose final type is `unknown` or `any`.
      const asExprs = findByKind(root, 'as_expression');
      for (const outer of asExprs) {
        const children = outer.children();
        const inner = children[0];
        if (!inner || inner.kind() !== 'as_expression') continue;
        // inner's last child is the cast-away type (predefined_type: unknown/any)
        const innerChildren = inner.children();
        const innerType = innerChildren[innerChildren.length - 1];
        if (!innerType) continue;
        const typeText = innerType.text();
        if (typeText === 'unknown' || typeText === 'any') {
          violations.push({
            rule: '',
            severity: 'error',
            source: 'core',
            message:
              opts.message ??
              `Double cast \`as ${typeText} as X\` bypasses the type system — use a type guard`,
            path: file.path,
            line: startLine(outer),
          });
        }
      }
      return violations;
    });
}

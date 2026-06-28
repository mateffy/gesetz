import { Effect } from 'effect';
import type { Check, Violation } from '@gesetz/core';
import { parseFile, findByKind, startLine } from './shared';

export interface NoTypedAnyOptions {
  readonly message?: string;
}

/**
 * Bans `any` type annotations (`: any`, `as any`, `<any>`).
 *
 * Implemented with ast-grep (syntactic). No type checker required.
 *
 * @example
 * select('src/**\/*.{ts,tsx}').check(noTypedAny())
 */
export function noTypedAny(opts: NoTypedAnyOptions = {}): Check {
  return (file) =>
    Effect.sync(() => {
      const root = parseFile(file.content, file.path);
      if (root === null) return [];

      const violations: Violation[] = [];
      // `any` shows up as a `predefined_type` node with text "any".
      const predefs = findByKind(root, 'predefined_type');
      for (const node of predefs) {
        if (node.text() === 'any') {
          violations.push({
            rule: '',
            severity: 'error',
            source: 'core',
            message: opts.message ?? 'Unexpected `any` type annotation — use `unknown` or a concrete type',
            path: file.path,
            line: startLine(node),
          });
        }
      }
      return violations;
    });
}

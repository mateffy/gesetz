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
 * @deprecated Use oxlint's `typescript/no-explicit-any` (the `typescript` plugin
 * is enabled by default), which is the same rule ESLint users know and is
 * maintained upstream:
 *
 * ```jsonc
 * // .oxlintrc.json
 * { "rules": { "typescript/no-explicit-any": "error" } }
 * ```
 *
 * Kept for projects without oxlint. Expect removal in a future major version.
 *
 * @example
 * select('src/scripts/\*.{ts,tsx}').check(noTypedAny())
 */
export function noTypedAny(opts: NoTypedAnyOptions = {}): Check {
  return async (file) => {
    const root = parseFile(file.content, file.path);
    if (root === null) return [];

    const violations: Violation[] = [];
    // `any` shows up as a `predefined_type` node with text "any".
    const predefs = findByKind(root, 'predefined_type');
    for (const node of predefs) {
      if (node.text() === 'any') {
        violations.push({
          severity: 'error',
          source: 'core',
          message:
            opts.message ?? 'Unexpected `any` type annotation — use `unknown` or a concrete type',
          path: file.path,
          line: startLine(node),
        });
      }
    }
    return violations;
  };
}

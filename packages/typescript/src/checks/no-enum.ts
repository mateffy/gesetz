import { Effect } from 'effect';
import type { Check, Violation } from '@gesetz/core';
import { parseFile, findByKind, startLine } from './shared';

export interface NoEnumOptions {
  readonly message?: string;
}

/**
 * Bans TypeScript `enum` declarations. Prefer union types or literal-object
 * maps (`as const`) — enums have runtime cost and cross-module isolation
 * quirks.
 *
 * Implemented with ast-grep (syntactic).
 *
 * @example
 * select('src/**\/*.{ts,tsx}').check(noEnum())
 */
export function noEnum(opts: NoEnumOptions = {}): Check {
  return (file) =>
    Effect.sync(() => {
      const root = parseFile(file.content, file.path);
      if (root === null) return [];

      const violations: Violation[] = [];
      const enumDecls = findByKind(root, 'enum_declaration');
      for (const node of enumDecls) {
        violations.push({
          rule: '',
          severity: 'warn',
          source: 'core',
          message:
            opts.message ??
            'Avoid TypeScript `enum` — use a union type or `as const` object map',
          path: file.path,
          line: startLine(node),
        });
      }
      return violations;
    });
}

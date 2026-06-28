import { Effect } from 'effect';
import type { Check, Violation } from '@gesetz/core';
import { parseFile, findByKind, startLine } from './shared';

export interface NoDefaultExportOptions {
  readonly message?: string;
}

/**
 * Bans `export default` declarations. Named exports improve refactorability
 * and IDE auto-import behaviour.
 *
 * Implemented with ast-grep (syntactic).
 *
 * @example
 * select('src/**\/*.{ts,tsx}').check(noDefaultExport())
 */
export function noDefaultExport(opts: NoDefaultExportOptions = {}): Check {
  return (file) =>
    Effect.sync(() => {
      const root = parseFile(file.content, file.path);
      if (root === null) return [];

      const violations: Violation[] = [];
      const exportStmts = findByKind(root, 'export_statement');
      for (const node of exportStmts) {
        const hasDefault = node.children().some((c) => c.kind() === 'default');
        if (hasDefault) {
          violations.push({
            rule: '',
            severity: 'warn',
            source: 'core',
            message: opts.message ?? 'Avoid `export default` — use a named export instead',
            path: file.path,
            line: startLine(node),
          });
        }
      }
      return violations;
    });
}

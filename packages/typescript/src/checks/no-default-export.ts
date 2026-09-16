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
 * @deprecated Use oxlint's `import/no-default-export`. Note that the `import`
 * plugin is **not** enabled by default in oxlint, so it has to be listed:
 *
 * ```jsonc
 * // .oxlintrc.json
 * { "plugins": ["import"], "rules": { "import/no-default-export": "error" } }
 * ```
 *
 * Kept for projects without oxlint. Expect removal in a future major version.
 *
 * @example
 * select('src/scripts/\*.{ts,tsx}').check(noDefaultExport())
 */
export function noDefaultExport(opts: NoDefaultExportOptions = {}): Check {
  return async (file) => {
    const root = parseFile(file.content, file.path);
    if (root === null) return [];

    const violations: Violation[] = [];
    const exportStmts = findByKind(root, 'export_statement');
    for (const node of exportStmts) {
      const hasDefault = node.children().some((c) => c.kind() === 'default');
      if (hasDefault) {
        violations.push({
          severity: 'warn',
          source: 'core',
          message: opts.message ?? 'Avoid `export default` — use a named export instead',
          path: file.path,
          line: startLine(node),
        });
      }
    }
    return violations;
  };
}

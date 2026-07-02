import type { StructureItem } from '../../services/syntax-tree';
import type { Check, Violation } from '../../engine/rule';

export interface RequireDocstringsOptions {
  /** e.g. ['function', 'class']. Default: ['function', 'class', 'method'] */
  readonly kinds?: readonly string[];
  readonly message?: string;
  readonly severity?: Violation['severity'];
}

/**
 * Requires that structural items have attached docstrings. Uses
 * `SyntaxTree.extractStructure` with `docstrings: true`.
 *
 * @example
 * // All functions and classes must have docstrings
 * requireDocstrings({ kinds: ['function', 'class'] })
 */
export function requireDocstrings(opts: RequireDocstringsOptions = {}): Check {
  const kinds = opts.kinds ?? ['function', 'class', 'method'];

  return async (file, { syntaxTree: st }) => {
    if (!st.canProcess(file)) return [];

    try {
      const result = await st.process(file, { structure: true, docstrings: true });
      const violations: Violation[] = [];

      function checkItems(items: readonly StructureItem[]): void {
        for (const item of items) {
          if (kinds.includes(item.kind) && !item.docstring) {
            violations.push({
              severity: opts.severity ?? 'warn',
              source: 'core',
              message: opts.message ?? `'${item.name}' is missing a docstring`,
              path: file.path,
              line: item.startLine,
            });
          }
          if (item.children.length > 0) checkItems(item.children);
        }
      }

      checkItems(result.structure);
      return violations;
    } catch {
      return [];
    }
  };
}

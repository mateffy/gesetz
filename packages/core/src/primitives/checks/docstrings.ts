import { Effect } from 'effect';
import { SyntaxTree } from '../../services/syntax-tree';
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

  return (file) =>
    Effect.gen(function* () {
      const st = yield* SyntaxTree;
      if (!st.canProcess(file)) return [];

      const result = yield* st.process(file, { structure: true, docstrings: true }).pipe(
        Effect.catchAll(() => Effect.succeed({ imports: [], calls: [], exports: [], structure: [] })),
      );
      const violations: Violation[] = [];

      function checkItems(items: readonly StructureItem[]): void {
        for (const item of items) {
          if (kinds.includes(item.kind) && !item.docstring) {
            violations.push({
              rule: '',
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
    });
}

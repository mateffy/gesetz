import { Effect } from 'effect';
import { SyntaxTree } from '../../services/syntax-tree';
import type { StructureItem } from '../../services/syntax-tree';
import type { Check, Violation } from '../../engine/rule';

export interface RequireMinStructureCountOptions {
  readonly message?: string;
  readonly severity?: Violation['severity'];
}

/**
 * Requires that the file declares at least `minCount` structural items of the
 * given kind (recursively, including nested children). Uses
 * `SyntaxTree.extractStructure`.
 *
 * @example
 * // Every test file must declare at least 1 function
 * requireMinStructureCount('function', 1)
 */
export function requireMinStructureCount(
  kind: string,
  minCount: number,
  opts: RequireMinStructureCountOptions = {},
): Check {
  return (file) =>
    Effect.gen(function* () {
      const st = yield* SyntaxTree;
      if (!st.canProcess(file)) return [];

      const result = yield* st.process(file, { structure: true }).pipe(
        Effect.catchAll(() => Effect.succeed({ imports: [], calls: [], exports: [], structure: [] })),
      );

      function countKind(items: readonly StructureItem[]): number {
        return items.reduce((sum, item) => {
          const self = item.kind === kind ? 1 : 0;
          return sum + self + countKind(item.children);
        }, 0);
      }

      const count = countKind(result.structure);
      if (count >= minCount) return [];

      return [
        {
          rule: '',
          severity: opts.severity ?? 'warn',
          source: 'core',
          message:
            opts.message ??
            `Expected at least ${minCount} '${kind}' declaration(s), found ${count}`,
          path: file.path,
        },
      ];
    });
}

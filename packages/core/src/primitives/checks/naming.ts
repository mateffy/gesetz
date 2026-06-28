import { Effect } from 'effect';
import { SyntaxTree } from '../../services/syntax-tree';
import type { StructureItem } from '../../services/syntax-tree';
import type { Check, Violation } from '../../engine/rule';

export interface RequireNamingConventionOptions {
  /** e.g. ['function', 'class'] — if omitted, all kinds */
  readonly kinds?: readonly string[];
  readonly pattern: RegExp;
  readonly message?: string;
  readonly severity?: Violation['severity'];
}

/**
 * Requires that structural items (functions, classes, methods, etc.) match
 * a naming convention. Uses `SyntaxTree.extractStructure`.
 *
 * @example
 * // All functions and classes must be camelCase or PascalCase
 * requireNamingConvention({ kinds: ['function', 'class'], pattern: /^[a-zA-Z][a-zA-Z0-9]*$/ })
 */
export function requireNamingConvention(opts: RequireNamingConventionOptions): Check {
  return (file) =>
    Effect.gen(function* () {
      const st = yield* SyntaxTree;
      if (!st.canProcess(file)) return [];

      const result = yield* st.process(file, { structure: true }).pipe(
        Effect.catchAll(() => Effect.succeed({ imports: [], calls: [], exports: [], structure: [] })),
      );
      const violations: Violation[] = [];

      function checkItems(items: readonly StructureItem[]): void {
        for (const item of items) {
          const kindMatch = !opts.kinds || opts.kinds.includes(item.kind);
          if (kindMatch && !opts.pattern.test(item.name)) {
            violations.push({
              rule: '',
              severity: opts.severity ?? 'warn',
              source: 'core',
              message:
                opts.message ?? `'${item.name}' does not match naming convention ${opts.pattern}`,
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

export interface NoForbiddenNamesOptions {
  readonly kinds?: readonly string[];
  readonly message?: (name: string) => string;
  readonly severity?: Violation['severity'];
}

/**
 * Bans specific names (or names matching a regex) from appearing on structural
 * items. Uses `SyntaxTree.extractStructure`.
 *
 * @example
 * // No functions or classes named 'foo' or 'bar'
 * noForbiddenNames(['foo', 'bar'])
 */
export function noForbiddenNames(
  names: readonly string[] | RegExp,
  opts: NoForbiddenNamesOptions = {},
): Check {
  const matcher = Array.isArray(names)
    ? (n: string) => (names as readonly string[]).includes(n)
    : (n: string) => (names as RegExp).test(n);

  return (file) =>
    Effect.gen(function* () {
      const st = yield* SyntaxTree;
      if (!st.canProcess(file)) return [];

      const result = yield* st.process(file, { structure: true }).pipe(
        Effect.catchAll(() => Effect.succeed({ imports: [], calls: [], exports: [], structure: [] })),
      );
      const violations: Violation[] = [];

      function checkItems(items: readonly StructureItem[]): void {
        for (const item of items) {
          const kindMatch = !opts.kinds || opts.kinds.includes(item.kind);
          if (kindMatch && matcher(item.name)) {
            violations.push({
              rule: '',
              severity: opts.severity ?? 'error',
              source: 'core',
              message: opts.message?.(item.name) ?? `Forbidden name: '${item.name}'`,
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

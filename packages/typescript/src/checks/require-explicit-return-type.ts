import { Effect } from 'effect';
import type { Check, Violation } from '@gesetz/core';
import { parseFile, findByKind, findChildText, startLine } from './shared';

export interface RequireExplicitReturnTypeOptions {
  /** Kinds to check. Default: ['function', 'method'] */
  readonly kinds?: readonly ('function' | 'method')[];
  /** Skip functions whose name matches these patterns (e.g. test fns). */
  readonly ignore?: RegExp;
  readonly message?: string;
}

/**
 * Requires that public functions and methods declare an explicit return type.
 * Inferred return types drift silently; explicit annotations keep APIs stable.
 *
 * "Explicit return type" means a syntactically present `: Type` annotation —
 * no type checker is required.
 *
 * Implemented with ast-grep (syntactic).
 *
 * @example
 * select('src/**\/*.{ts,tsx}').check(requireExplicitReturnType())
 */
export function requireExplicitReturnType(
  opts: RequireExplicitReturnTypeOptions = {},
): Check {
  const kinds = new Set(opts.kinds ?? ['function', 'method']);
  const ignore = opts.ignore;

  return (file) =>
    Effect.sync(() => {
      const root = parseFile(file.content, file.path);
      if (root === null) return [];

      const violations: Violation[] = [];

      const hasReturnType = (node: import('@ast-grep/napi').SgNode): boolean =>
        node.children().some((c) => c.kind() === 'type_annotation');

      const checkDecl = (name: string, hasType: boolean, line: number): void => {
        if (ignore && ignore.test(name)) return;
        if (hasType) return;
        violations.push({
          rule: '',
          severity: 'warn',
          source: 'core',
          message:
            opts.message ?? `Function '${name}' must declare an explicit return type`,
          path: file.path,
          line,
        });
      };

      if (kinds.has('function')) {
        for (const fn of findByKind(root, 'function_declaration')) {
          const name = findChildText(fn, 'identifier') ?? '<anonymous>';
          checkDecl(name, hasReturnType(fn), startLine(fn));
        }
      }

      if (kinds.has('method')) {
        for (const m of findByKind(root, 'method_definition')) {
          const name = findChildText(m, 'property_identifier') ?? '<anonymous>';
          checkDecl(name, hasReturnType(m), startLine(m));
        }
      }

      return violations;
    });
}

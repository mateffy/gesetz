import type { Check, Violation } from '../../engine/rule';
import { flattenStructure } from './walk';

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
  return async (file, { syntax }) => {
    if (!syntax.canProcess(file)) return [];

    try {
      const result = await syntax.process(file, { structure: true });
      return flattenStructure(result.structure)
        .filter((item) => !opts.kinds || opts.kinds.includes(item.kind))
        .filter((item) => !opts.pattern.test(item.name))
        .map((item): Violation => ({
          severity: opts.severity ?? 'warn',
          source: 'core',
          message:
            opts.message ?? `'${item.name}' does not match naming convention ${opts.pattern}`,
          path: file.path,
          line: item.startLine,
        }));
    } catch {
      return [];
    }
  };
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

  return async (file, { syntax }) => {
    if (!syntax.canProcess(file)) return [];

    try {
      const result = await syntax.process(file, { structure: true });
      return flattenStructure(result.structure)
        .filter((item) => !opts.kinds || opts.kinds.includes(item.kind))
        .filter((item) => matcher(item.name))
        .map((item): Violation => ({
          severity: opts.severity ?? 'error',
          source: 'core',
          message: opts.message?.(item.name) ?? `Forbidden name: '${item.name}'`,
          path: file.path,
          line: item.startLine,
        }));
    } catch {
      return [];
    }
  };
}

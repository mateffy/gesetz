import type { Check, Violation } from '../../engine/rule';
import { flattenStructure } from './walk';

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

  return async (file, { syntax }) => {
    if (!syntax.canProcess(file)) return [];

    try {
      const result = await syntax.process(file, { structure: true, docstrings: true });
      return flattenStructure(result.structure)
        .filter((item) => kinds.includes(item.kind) && !item.docstring)
        .map((item): Violation => ({
          severity: opts.severity ?? 'warn',
          source: 'core',
          message: opts.message ?? `'${item.name}' is missing a docstring`,
          path: file.path,
          line: item.startLine,
        }));
    } catch {
      return [];
    }
  };
}

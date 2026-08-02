import type { Check, Violation } from '@gesetz/core';
import { parseFile, findByKind, findChildText, startLine } from './shared';

/**
 * Checks that the file does not define local helper function components
 * (functions returning JSX that are not the main exported component).
 *
 * Implemented with ast-grep (syntactic) for JSX detection + `SyntaxTree`
 * (oxc-parser) for the exported-names list. Replaces the ts-morph version.
 *
 * @example
 * // Route files must not define local helper components
 * noLocalFunctionComponents({ excludeExportedNames: true })
 */
export function noLocalFunctionComponents(
  opts: {
    readonly message?: (name: string) => string;
    /** If true, only flag non-exported components (default: flag all non-main components) */
    readonly excludeExportedNames?: boolean;
  } = {},
): Check {
  return async (file, { syntax }) => {
    const root = parseFile(file.content, file.path);
    if (root === null) return [];

    // Build the set of exported names via the SyntaxTree service (oxc-parser).
    let exportedNames = new Set<string>();
    if (syntax.canProcess(file)) {
      try {
        const result = await syntax.process(file, { exports: true });
        exportedNames = new Set(result.exports.map((e) => e.name));
      } catch {
        // ignore parse errors
      }
    }

    const violations: Violation[] = [];
    const functions = findByKind(root, 'function_declaration');

    for (const fn of functions) {
      const name = findChildText(fn, 'identifier');
      if (!name || name === 'default') continue;
      if (opts.excludeExportedNames && exportedNames.has(name)) continue;
      if (exportedNames.has(name)) continue; // main export — skip

      // Check if it contains JSX. ast-grep parses `<>...</>` as a
      // `jsx_element` with an empty opening, so `jsx_element` +
      // `jsx_self_closing_element` covers all JSX forms.
      const hasJsx =
        fn.findAll({ rule: { kind: 'jsx_element' } }).length > 0 ||
        fn.findAll({ rule: { kind: 'jsx_self_closing_element' } }).length > 0;

      if (hasJsx) {
        violations.push({
          severity: 'error',
          source: 'core',
          message:
            opts.message?.(name) ??
            `Local function component '${name}' should be moved to its own file`,
          path: file.path,
          line: startLine(fn),
        });
      }
    }

    return violations;
  };
}

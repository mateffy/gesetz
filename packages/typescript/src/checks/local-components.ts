import { Effect } from 'effect';
import type { Check, Violation } from '@regeln/core';
import type { FunctionDeclaration } from 'ts-morph';
import { loadSourceFile } from './shared';

/**
 * Checks that the file does not define local helper function components
 * (functions returning JSX that are not the main exported component).
 *
 * @example
 * // Route files must not define local helper components
 * noLocalFunctionComponents({ excludeExportedNames: true })
 */
export function noLocalFunctionComponents(
  opts: {
    tsConfigPath?: string;
    message?: (name: string) => string;
    /** If true, only flag non-exported components (default: flag all non-main components) */
    excludeExportedNames?: boolean;
  } = {},
): Check {
  return (file) =>
    Effect.gen(function* () {
      const sourceFile = yield* loadSourceFile(file.absolutePath, opts.tsConfigPath);

      if (sourceFile === null) return [];

      const sf = sourceFile._tsMorph;
      const violations: Violation[] = [];

      // Get all exported declaration names to identify the "main" component
      const exportedNames = new Set<string>(
        [...sf.getExportedDeclarations()].map(([name]) => name),
      );

      // SyntaxKind.FunctionDeclaration = 259
      const functions: readonly FunctionDeclaration[] = sf.getDescendantsOfKind?.(259) ?? [];

      for (const fn of functions) {
        const name = fn.getName?.();
        if (!name || name === 'default') continue;
        if (opts.excludeExportedNames && exportedNames.has(name)) continue;
        if (exportedNames.has(name)) continue; // main export — skip

        // Check if it contains JSX
        const hasJsx = fn.getDescendantsOfKind?.(281)?.length > 0 ||
          fn.getDescendantsOfKind?.(283)?.length > 0 ||
          fn.getDescendantsOfKind?.(284)?.length > 0; // JsxFragment

        if (hasJsx) {
          violations.push({
            rule: '',
            severity: 'error',
            source: 'core',
            message:
              opts.message?.(name) ??
              `Local function component '${name}' should be moved to its own file`,
            path: file.path,
            line: fn.getStartLineNumber?.(),
          });
        }
      }

      return violations;
    });
}

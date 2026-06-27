import { Effect } from 'effect';
import type { Check, Violation } from '@gesetz/core';
import { SyntaxKind } from 'ts-morph';
import type { FunctionDeclaration, SourceFile } from 'ts-morph';
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

      const sf = sourceFile._tsMorph as SourceFile;
      const violations: Violation[] = [];

      // Get all exported declaration names to identify the "main" component
      const exportedNames = new Set<string>(
        [...sf.getExportedDeclarations()].map(([name]) => name),
      );

      const functions: readonly FunctionDeclaration[] = sf.getDescendantsOfKind?.(SyntaxKind.FunctionDeclaration) ?? [];

      for (const fn of functions) {
        const name = fn.getName?.();
        if (!name || name === 'default') continue;
        if (opts.excludeExportedNames && exportedNames.has(name)) continue;
        if (exportedNames.has(name)) continue; // main export — skip

        // Check if it contains JSX
        const hasJsx = fn.getDescendantsOfKind?.(SyntaxKind.JsxElement)?.length > 0 ||
          fn.getDescendantsOfKind?.(SyntaxKind.JsxSelfClosingElement)?.length > 0 ||
          fn.getDescendantsOfKind?.(SyntaxKind.JsxFragment)?.length > 0;

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

import { Effect } from 'effect';
import micromatch from 'micromatch';
import type { Check, Violation } from '@regeln/core';
import type { ImportDeclaration } from 'ts-morph';
import { loadSourceFile } from './shared';

/**
 * Checks that files matching `source` (module specifier) are only imported by
 * files matching `allowedIn` (file path glob or array of globs).
 *
 * @example
 * // Generated types can only be imported inside src/sdk/
 * requireImportBoundary({ source: /types\.gen/, allowedIn: 'src/sdk/**' })
 */
export function requireImportBoundary(opts: {
  source: string | RegExp;
  allowedIn: string | string[];
  tsConfigPath?: string;
  message?: string;
}): Check {
  const sourceMatcher =
    typeof opts.source === 'string'
      ? (specifier: string) => specifier.includes(opts.source as string)
      : (specifier: string) => (opts.source as RegExp).test(specifier);

  const allowedPatterns = Array.isArray(opts.allowedIn) ? opts.allowedIn : [opts.allowedIn];

  return (file) =>
    Effect.gen(function* () {
      const sourceFile = yield* loadSourceFile(file.absolutePath, opts.tsConfigPath);

      if (sourceFile === null) return [];

      const sf = sourceFile._tsMorph;
      const violations: Violation[] = [];

      // Check if this file is allowed to import the source
      const isAllowed = micromatch.isMatch(file.path, allowedPatterns);
      if (isAllowed) return [];

      // SyntaxKind.ImportDeclaration = 269
      const imports: readonly ImportDeclaration[] = sf.getDescendantsOfKind?.(269) ?? [];

      for (const imp of imports) {
        const specifier = imp.getModuleSpecifier?.()?.getLiteralText?.();
        if (typeof specifier === 'string' && sourceMatcher(specifier)) {
          violations.push({
            rule: '',
            severity: 'error',
            source: 'core',
            message:
              opts.message ??
              `Import from '${specifier}' is not allowed outside of '${allowedPatterns.join(', ')}'`,
            path: file.path,
            line: imp.getStartLineNumber?.(),
          });
        }
      }

      return violations;
    });
}

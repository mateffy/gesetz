import { Effect } from 'effect';
import { SyntaxTree } from '../../services/syntax-tree';
import type { Check, Violation } from '../../engine/rule';

/**
 * Simple regex fallback for extracting import specifiers from JS/TS-like
 * source. Used when no SyntaxBackend is registered for the file's extension,
 * so users who haven't added adapters yet keep the existing behaviour.
 */
function regexExtractImports(content: string): string[] {
  const results: string[] = [];
  const patterns = [
    /(?:^|\n)\s*import\s+(?:type\s+)?(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]/g,
    /require\(['"]([^'"]+)['"]\)/g,
    /\bimport\(['"]([^'"]+)['"]\)/g,
  ];
  for (const p of patterns) {
    let m: RegExpExecArray | null;
    while ((m = p.exec(content)) !== null) {
      if (m[1]) results.push(m[1]);
    }
  }
  return results;
}

/**
 * Checks that the file does not import from a given module.
 * The module can be a string (exact match or prefix) or a RegExp.
 *
 * Uses `SyntaxTree.extractImports` when a backend is registered for the
 * file's extension; otherwise falls back to a JS/TS regex.
 *
 * @example
 * // Components must not use @tanstack/react-query directly
 * noImportFrom('@tanstack/react-query', { message: 'Use SDK hooks instead' })
 */
export function noImportFrom(
  module: string | RegExp,
  opts: { message?: string; severity?: Violation['severity'] } = {},
): Check {
  const matcher =
    typeof module === 'string'
      ? (specifier: string) => specifier === module || specifier.startsWith(module + '/')
      : (specifier: string) => module.test(specifier);

  const label = typeof module === 'string' ? module : module.source;

  return (file) =>
    Effect.gen(function* () {
      const st = yield* SyntaxTree;
      const violations: Violation[] = [];

      if (st.canProcess(file)) {
        const result = yield* st.process(file, { imports: true }).pipe(
          Effect.catchAll(() => Effect.succeed({ imports: [], calls: [], exports: [], structure: [] })),
        );
        for (const imp of result.imports) {
          if (matcher(imp.specifier)) {
            violations.push({
              rule: '',
              severity: opts.severity ?? 'error',
              source: 'core',
              message: opts.message ?? `Forbidden import from '${label}'`,
              path: file.path,
              line: imp.line,
            });
          }
        }
        return violations;
      }

      // Regex fallback for unregistered extensions
      for (const specifier of regexExtractImports(file.content)) {
        if (matcher(specifier)) {
          violations.push({
            rule: '',
            severity: opts.severity ?? 'error',
            source: 'core',
            message: opts.message ?? `Forbidden import from '${label}'`,
            path: file.path,
          });
        }
      }
      return violations;
    });
}

/**
 * Checks that the file imports from a given module (at least once).
 *
 * @example
 * // All test files must import from vitest
 * requireImportFrom('vitest')
 */
export function requireImportFrom(
  module: string | RegExp,
  opts: { message?: string; severity?: Violation['severity'] } = {},
): Check {
  const matcher =
    typeof module === 'string'
      ? (specifier: string) => specifier === module || specifier.startsWith(module + '/')
      : (specifier: string) => module.test(specifier);

  const label = typeof module === 'string' ? module : module.source;

  return (file) =>
    Effect.gen(function* () {
      const st = yield* SyntaxTree;

      let specifiers: string[];
      if (st.canProcess(file)) {
        const result = yield* st.process(file, { imports: true }).pipe(
          Effect.catchAll(() => Effect.succeed({ imports: [], calls: [], exports: [], structure: [] })),
        );
        specifiers = result.imports.map((i) => i.specifier);
      } else {
        specifiers = regexExtractImports(file.content);
      }

      if (specifiers.some(matcher)) return [];

      return [
        {
          rule: '',
          severity: opts.severity ?? 'error',
          source: 'core' as const,
          message: opts.message ?? `Missing required import from '${label}'`,
          path: file.path,
        },
      ];
    });
}

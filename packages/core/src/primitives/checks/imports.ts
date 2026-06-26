import { Effect } from 'effect';
import type { Check, Violation } from '../../engine/rule';

/**
 * Extracts import/export module specifiers from TypeScript/JavaScript source.
 * Returns an array of quoted module strings found in the file.
 */
function extractImports(content: string): string[] {
  const staticImports = [...content.matchAll(/(?:import|export)\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"]/g)];
  const dynamicImports = [...content.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)];
  const requires = [...content.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)];

  return [
    ...staticImports.map((m) => m[1] ?? ''),
    ...dynamicImports.map((m) => m[1] ?? ''),
    ...requires.map((m) => m[1] ?? ''),
  ].filter(Boolean);
}

/**
 * Checks that the file does not import from a given module.
 * The module can be a string (exact match) or a RegExp.
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

  return (file) =>
    Effect.sync(() => {
      const imports = extractImports(file.content);
      const violations: Violation[] = [];

      for (const specifier of imports) {
        if (matcher(specifier)) {
          violations.push({
            rule: '',
            severity: opts.severity ?? 'error',
            source: 'core',
            message:
              opts.message ??
              `Forbidden import from '${typeof module === 'string' ? module : module.source}'`,
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

  return (file) =>
    Effect.sync(() => {
      const imports = extractImports(file.content);
      const found = imports.some(matcher);
      if (found) return [];

      return [
        {
          rule: '',
          severity: opts.severity ?? 'error',
          source: 'core' as const,
          message:
            opts.message ??
            `Missing required import from '${typeof module === 'string' ? module : module.source}'`,
          path: file.path,
        },
      ];
    });
}

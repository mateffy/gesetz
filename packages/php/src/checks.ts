import { Effect } from 'effect';
import type { Check, Violation } from '@regeln/core';

/**
 * Checks that PHP files declare strict types.
 * This is a text-based check — no tree-sitter required.
 *
 * @example
 * select('app/**\/*.php').label('PHP strict types required').check(strictTypes())
 */
export function strictTypes(opts: { message?: string } = {}): Check {
  return (file) =>
    Effect.sync(() => {
      const hasDeclaration = /declare\s*\(\s*strict_types\s*=\s*1\s*\)/.test(file.content);
      if (hasDeclaration) return [];

      return [
        {
          rule: '',
          severity: 'error' as const,
          source: 'core' as const,
          message: opts.message ?? `Missing declare(strict_types=1) in ${file.name}`,
          path: file.path,
        },
      ];
    });
}

/**
 * Checks that the PHP namespace matches the PSR-4 directory structure.
 * The namespace is extracted from the file content and compared to the file path.
 *
 * @example
 * psrNamespace({ baseNamespace: 'App', basePath: 'app' })
 */
export function psrNamespace(opts: {
  baseNamespace: string;
  basePath: string;
  message?: string;
}): Check {
  return (file) =>
    Effect.sync(() => {
      const namespaceMatch = /^\s*namespace\s+([\w\\]+)\s*;/m.exec(file.content);
      if (!namespaceMatch) return [];

      const declaredNamespace = namespaceMatch[1] ?? '';
      const relativePath = file.dir.replace(/\\/g, '/');

      // Remove basePath prefix
      const normalizedBase = opts.basePath.replace(/^\/|\/$/g, '');
      const normalizedDir = relativePath.replace(/^\/|\/$/g, '');

      let pathAfterBase = normalizedDir;
      if (normalizedBase && normalizedDir.startsWith(normalizedBase)) {
        pathAfterBase = normalizedDir.slice(normalizedBase.length).replace(/^\//, '');
      } else if (normalizedBase && !normalizedDir.startsWith(normalizedBase)) {
        return []; // File is outside the base path — skip
      }

      // Construct expected namespace from path
      const pathSegments = pathAfterBase ? pathAfterBase.split('/') : [];
      const expectedNamespace = [opts.baseNamespace, ...pathSegments]
        .filter(Boolean)
        .join('\\');

      if (declaredNamespace === expectedNamespace) return [];

      return [
        {
          rule: '',
          severity: 'error' as const,
          source: 'core' as const,
          message:
            opts.message ??
            `Namespace '${declaredNamespace}' does not match expected '${expectedNamespace}'`,
          path: file.path,
        },
      ];
    });
}

/**
 * Checks that the file does not use any of the provided call patterns.
 * Patterns are user-supplied and matched line-by-line.
 *
 * This check is intentionally generic — the caller provides the framework-specific
 * patterns. Examples:
 * - Laravel: `['DB::table', 'DB::raw', 'DB::statement']`
 * - WordPress: `['$wpdb->query', '$wpdb->get_results']`
 * - Raw PHP: `['PDO::query', 'mysqli_query']`
 *
 * @example
 * // Laravel — no inline raw DB queries
 * noInlineQueries(['DB::table', 'DB::raw'], { message: 'Use Eloquent instead of DB::' })
 */
export function noInlineQueries(
  patterns: string[],
  opts: { message?: string; severity?: Violation['severity'] } = {},
): Check {
  return (file) =>
    Effect.sync(() => {
      const violations: Violation[] = [];
      const lines = file.content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        const matched = patterns.find((pattern) => line.includes(pattern));
        if (matched) {
          violations.push({
            rule: '',
            severity: opts.severity ?? 'error',
            source: 'core',
            message: opts.message ?? `Forbidden call pattern: ${matched}`,
            path: file.path,
            line: i + 1,
          });
        }
      }

      return violations;
    });
}

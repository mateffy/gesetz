import { Effect } from 'effect';
import type { Check, Violation } from '../../engine/rule';

/**
 * Checks that the file does not contain content matching a regex.
 * Matches line-by-line by default; use `{ fullFile: true }` for whole-file matching.
 *
 * @example
 * // No PHP files should use the old helper
 * noPattern(/legacy_helper\(/, { message: 'Use the new helper() instead' })
 */
export function noPattern(
  regex: RegExp,
  opts: {
    message?: string;
    severity?: Violation['severity'];
    fullFile?: boolean;
  } = {},
): Check {
  return (file) =>
    Effect.sync(() => {
      const violations: Violation[] = [];

      if (opts.fullFile) {
        if (regex.test(file.content)) {
          violations.push({
            rule: '',
            severity: opts.severity ?? 'error',
            source: 'core',
            message: opts.message ?? `File matches forbidden pattern: ${regex.source}`,
            path: file.path,
          });
        }
      } else {
        const lines = file.content.split('\n');
        lines.forEach((line, index) => {
          if (regex.test(line)) {
            violations.push({
              rule: '',
              severity: opts.severity ?? 'error',
              source: 'core',
              message: opts.message ?? `Forbidden pattern: ${regex.source}`,
              path: file.path,
              line: index + 1,
            });
          }
        });
      }

      return violations;
    });
}

/**
 * Checks that the file contains content matching a regex at least once.
 *
 * @example
 * // All PHP files must declare strict types
 * requirePattern(/declare\(strict_types=1\)/, { message: 'Missing declare(strict_types=1)' })
 */
export function requirePattern(
  regex: RegExp,
  opts: {
    message?: string;
    severity?: Violation['severity'];
  } = {},
): Check {
  return (file) =>
    Effect.sync(() => {
      if (regex.test(file.content)) return [];

      return [
        {
          rule: '',
          severity: opts.severity ?? 'error',
          source: 'core' as const,
          message: opts.message ?? `File must match pattern: ${regex.source}`,
          path: file.path,
        },
      ];
    });
}

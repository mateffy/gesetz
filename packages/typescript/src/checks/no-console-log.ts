import { Effect } from 'effect';
import type { Check, Violation } from '@gesetz/core';

export interface NoConsoleLogOptions {
  /**
   * Allow `console.warn` and `console.error`. Default: false (ban all console.*).
   */
  readonly allowWarnError?: boolean | undefined;
  readonly message?: string | undefined;
}

/**
 * Bans `console.log` (and optionally all `console.*`) in production files.
 *
 * Moved from `@gesetz/core` — this is a TypeScript/JavaScript-specific check.
 */
export function noConsoleLog(options: NoConsoleLogOptions = {}): Check {
  const pattern = options.allowWarnError
    ? /\bconsole\.(log|debug|info)\s*\(/g
    : /\bconsole\.(log|debug|info|warn|error)\s*\(/g;

  return (file) =>
    Effect.sync(() => {
      const violations: Violation[] = [];
      const lines = file.content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (pattern.test(line)) {
          violations.push({
            rule: 'no-console-log',
            message:
              options.message ??
              'Remove console logging from production code. Use a proper logger instead.',
            path: file.path,
            line: i + 1,
            severity: 'warn' as const,
            source: 'core' as const,
          });
        }
        pattern.lastIndex = 0;
      }
      return violations;
    });
}

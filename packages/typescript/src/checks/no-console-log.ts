import type { Check, Violation } from '@gesetz/core';

export interface NoConsoleLogOptions {
  /**
   * Allow `console.warn` and `console.error`. Default: false (ban all console.*).
   */
  readonly allowWarnError?: boolean | undefined;
  readonly message?: string | undefined;
}

/** A line that is a comment, or a continuation line of a block comment. */
const COMMENT_LINE = /^\s*(?:\/\/|\*|\/\*)/;

/**
 * Bans `console.log` (and optionally all `console.*`) in production calls.
 *
 * Moved from `@gesetz/core` — this is a TypeScript/JavaScript-specific check.
 *
 * Comment lines are skipped: this rule's own documentation contains the example
 * `"console.log(" matches but "notconsole.log(" does not`, and the check was
 * reporting itself. A mention in prose is not a call.
 *
 * Known limit: a trailing comment on a line of code is not distinguished,
 * because this check is deliberately regex-based rather than parse-based. A real
 * call on such a line is still reported.
 */
export function noConsoleLog(options: NoConsoleLogOptions = {}): Check {
  const pattern = options.allowWarnError
    ? /\bconsole\.(log|debug|info)\s*\(/g
    : /\bconsole\.(log|debug|info|warn|error)\s*\(/g;

  return async (file) => {
    const violations: Violation[] = [];
    const lines = file.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (COMMENT_LINE.test(line)) continue;
      if (pattern.test(line)) {
        violations.push({
          rule: 'no-console-log',
          message:
            options.message ??
            'Remove console logging from production code. Use a proper logger instead.',
          path: file.path,
          line: i + 1,
          severity: 'warn',
          source: 'core',
        });
      }
      pattern.lastIndex = 0;
    }
    return violations;
  };
}

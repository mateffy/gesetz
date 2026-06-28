import { Effect } from 'effect';
import type { Check, Violation } from '@gesetz/core';

export interface NoMagicNumbersOptions {
  /** Numbers that are always allowed. Default: [0, 1, -1, 2, 100] */
  readonly ignore?: number[] | undefined;
  readonly message?: string | undefined;
}

/**
 * Flags unexplained numeric literals in non-constant positions.
 * Only flags integers/floats not assigned to a SCREAMING_SNAKE_CASE const.
 *
 * Moved from `@gesetz/core` — this is a TypeScript/JavaScript-specific check.
 */
export function noMagicNumbers(options: NoMagicNumbersOptions = {}): Check {
  const ignore = new Set<number>(options.ignore ?? [0, 1, -1, 2, 100]);
  // Match numeric literals not in const UPPER_SNAKE = N; or enum values
  const numericLit = /(?<!\w)(-?\d+\.?\d*)(?!\w)/g;
  const constDecl = /^\s*(?:export\s+)?(?:const|readonly)\s+[A-Z][A-Z_0-9]+\s*=/;

  return (file) =>
    Effect.sync(() => {
      const violations: Violation[] = [];
      const lines = file.content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        // Skip named constant declarations and comment lines
        if (constDecl.test(line) || /^\s*\/\//.test(line) || /^\s*\*/.test(line)) continue;
        let match: RegExpExecArray | null;
        numericLit.lastIndex = 0;
        while ((match = numericLit.exec(line)) !== null) {
          const val = parseFloat(match[0] ?? '');
          if (!Number.isFinite(val) || ignore.has(val)) continue;
          violations.push({
            rule: 'no-magic-number',
            message:
              options.message ??
              `Magic number ${match[0]}. Extract to a named constant with a descriptive name.`,
            path: file.path,
            line: i + 1,
            severity: 'warn' as const,
            source: 'core' as const,
          });
        }
      }
      return violations.slice(0, 20); // cap output
    });
}

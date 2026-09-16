import type { Check, Violation } from '@gesetz/core';

/** Lines scanned after a catch block when deciding whether it is empty. */
const LOOKAHEAD_LINES = 3;

export interface NoEmptyCatchOptions {
  readonly message?: string | undefined;
}

/**
 * Detects empty or trivially-commented catch blocks that swallow errors.
 *
 * Moved from `@gesetz/core` — this is a TypeScript/JavaScript-specific check.
 *
 * @deprecated Use oxlint's `no-empty`:
 *
 * ```jsonc
 * // .oxlintrc.json
 * { "rules": { "no-empty": "error" } }
 * ```
 *
 * Kept for projects without oxlint. Expect removal in a future major version.
 */
export function noEmptyCatch(options: NoEmptyCatchOptions = {}): Check {
  return async (file) => {
    const violations: Violation[] = [];
    const lines = file.content.split('\n');
    // Simple state machine: look for catch { with no real body
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (/\}\s*catch\s*(\([^)]*\))?\s*\{/.test(line) || /catch\s*(\([^)]*\))?\s*\{/.test(line)) {
        const body = lines
          .slice(i + 1, i + 1 + LOOKAHEAD_LINES)
          .map((l) => l.trim())
          .filter((l) => l && l !== '}' && !l.startsWith('//') && !l.startsWith('*'));
        if (body.length === 0) {
          violations.push({
            rule: 'no-empty-catch',
            message:
              options.message ??
              'Empty catch block swallows errors. Log, rethrow, or handle explicitly.',
            path: file.path,
            line: i + 1,
            severity: 'error',
            source: 'core',
          });
        }
      }
    }
    return violations;
  };
}

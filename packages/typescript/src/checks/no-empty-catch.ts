import { Effect } from 'effect';
import type { Check, Violation } from '@gesetz/core';

export interface NoEmptyCatchOptions {
  readonly message?: string | undefined;
}

/**
 * Detects empty or trivially-commented catch blocks that swallow errors.
 *
 * Moved from `@gesetz/core` — this is a TypeScript/JavaScript-specific check.
 */
export function noEmptyCatch(options: NoEmptyCatchOptions = {}): Check {
  return (file) =>
    Effect.sync(() => {
      const violations: Violation[] = [];
      const lines = file.content.split('\n');
      // Simple state machine: look for catch { with no real body
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (/\}\s*catch\s*(\([^)]*\))?\s*\{/.test(line) || /catch\s*(\([^)]*\))?\s*\{/.test(line)) {
          // Check next 3 lines for real content
          const body = lines
            .slice(i + 1, i + 4)
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
              severity: 'error' as const,
              source: 'core' as const,
            });
          }
        }
      }
      return violations;
    });
}

import { Effect } from 'effect';
import type { Check, Violation } from '@gesetz/core';

export interface NoTrivialCommentOptions {
  readonly message?: string | undefined;
}

/**
 * Detects AI-generated narration comments that just restate the code.
 * Examples: `// Import React`, `// Define the component`, `// Return JSX`
 *
 * Moved from `@gesetz/core` — this is a TypeScript/JavaScript-specific check.
 */
export function noTrivialComment(options: NoTrivialCommentOptions = {}): Check {
  // Patterns that match AI-narration: "// Verb the Noun" or section dividers
  const narrationPattern =
    /^\s*\/\/\s*(?:import|define|create|add|set|update|delete|remove|return|export|initialize|handle|check|call|use|get|fetch|render|make|build|iterate|loop|map|filter)\s+\w/i;
  const dividerPattern = /^\s*\/\/\s*[-=*]{5,}/;

  return (file) =>
    Effect.sync(() => {
      const violations: Violation[] = [];
      const lines = file.content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (narrationPattern.test(line) || dividerPattern.test(line)) {
          violations.push({
            rule: 'no-trivial-comment',
            message:
              options.message ??
              'Trivial or narrative comment. Remove it — good code is self-explanatory.',
            path: file.path,
            line: i + 1,
            severity: 'info' as const,
            source: 'core' as const,
          });
        }
      }
      return violations;
    });
}

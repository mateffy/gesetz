import type { Check, Violation } from '@gesetz/core';

export interface NoTrivialCommentOptions {
  readonly message?: string | undefined;
}

/**
 * Markers that mean a comment is explaining rather than restating: a reason, a
 * contract, a mapping, a caveat, or a reference to an identifier.
 */
const EXPLAINS = /(?:\u2014|\bbecause\b|\bso that\b|\botherwise\b|\brather than\b|\binstead of\b|\bnote:|\bto avoid\b|\bsince\b|\bmust\b|\bcannot\b|\bwhy\b|->|\u2192|`|\()/i;

/** A short comment that restates the call on the next lines. */
const NARRATION =
  /^\/\/\s*(?:import|define|create|add|set|update|delete|remove|return|export|initialize|handle|check|call|use|get|fetch|render|make|build|iterate|loop|map|filter)\s+\w/i;

/** Section dividers: `// ─────` or `// =====`. */
const DIVIDER = /^\s*\/\/\s*[-=*]{5,}/;

/** A comment longer than this is carrying content, not narrating. */
const MAX_NARRATION_WORDS = 6;

/**
 * Detects narration comments that only restate the code beside them.
 *
 * Examples: `// Import React`, `// Return JSX`, `// Check expiry`.
 *
 * The rule used to flag any comment beginning with one of a list of verbs, which
 * also caught comments that explain a decision:
 *
 *   `// Check if it contains JSX. ast-grep parses <>...</> as a fragment ...`
 *   `// Set exit code without short-circuiting finalizers — lets the Effect ...`
 *   `// Filter on extension + raw type rather than a \`gesetz-syntax.import\` string`
 *
 * A comment earns its place when it says why, names a contract, or points at an
 * identifier; it is noise when it re-reads the next line aloud. Length and an
 * explanatory marker are used to tell those apart.
 */
export function noTrivialComment(options: NoTrivialCommentOptions = {}): Check {
  return async (file) => {
    const violations: Violation[] = [];
    const lines = file.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = (lines[i] ?? '').trim();
      if (DIVIDER.test(line)) continue;   // a section divider is a deliberate visual break
      if (!NARRATION.test(line)) continue;
      if (EXPLAINS.test(line)) continue;
      const words = line.replace(/^\/\/+\s*/, '').split(/\s+/).filter(Boolean).length;
      if (words > MAX_NARRATION_WORDS) continue;
      violations.push({
        rule: 'no-trivial-comment',
        message:
          options.message ?? 'Trivial or narrative comment. Remove it — good code is self-explanatory.',
        path: file.path,
        line: i + 1,
        severity: 'info',
        source: 'core',
      });
    }
    return violations;
  };
}

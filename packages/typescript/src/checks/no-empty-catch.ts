import type { Check, Violation } from '@gesetz/core';

export interface NoEmptyCatchOptions {
  readonly message?: string | undefined;
}

const CATCH_OPEN = /catch\s*(?:\([^)]*\))?\s*\{/g;

/** Index just past the brace that closes the block opened at `from`. */
function matchingBrace(content: string, from: number): number {
  let depth = 0;
  for (let i = from; i < content.length; i++) {
    const c = content[i]!;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return content.length;
}

/** Remove comments, then report whether anything is left. */
function hasCode(body: string): boolean {
  return (
    body
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('')
      .trim().length > 0
  );
}

/**
 * Detects empty or trivially-commented catch blocks that swallow errors.
 *
 * The body is the block's own braces, found by matching the opening brace to its
 * close. An earlier version inspected only the next three lines: a catch whose
 * explanation ran to four lines was reported as empty, and a catch with code on
 * its fifth line was reported as empty too. It also ignored comment lines when
 * deciding, so the count depended on how the explanation was formatted rather
 * than on whether anything was handled.
 */
export function noEmptyCatch(options: NoEmptyCatchOptions = {}): Check {
  return async (file) => {
    const violations: Violation[] = [];
    const content = file.content;

    for (const match of content.matchAll(CATCH_OPEN)) {
      const openBrace = match.index + match[0].length - 1;
      const closeBrace = matchingBrace(content, openBrace);
      const body = content.slice(openBrace + 1, closeBrace);
      if (hasCode(body)) continue;
      violations.push({
        rule: 'no-empty-catch',
        message:
          options.message ??
          'Empty catch block swallows errors. Log, rethrow, or handle explicitly.',
        path: file.path,
        line: content.slice(0, match.index).split('\n').length,
        severity: 'error',
        source: 'core',
      });
    }
    return violations;
  };
}

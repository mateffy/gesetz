import type { Check, Violation } from '@gesetz/core';

/** Upper bound on reported violations per file. */
const MAX_REPORTED = 20;

export interface NoMagicNumbersOptions {
  /** Numbers that are always allowed. Default: [0, 1, -1, 2, 100] */
  readonly ignore?: number[] | undefined;
  readonly message?: string | undefined;
}

/**
 * Previous non-whitespace character before `index`, or undefined at the start.
 */
function previousSignificant(source: string, index: number): string | undefined {
  for (let i = index - 1; i >= 0; i -= 1) {
    const c = source[i];
    if (c !== undefined && !/\s/.test(c)) return c;
  }
  return undefined;
}

/**
 * True when a `/` at `index` starts a regex literal rather than a division.
 *
 * A regex literal can only follow an operator, an opening bracket, or a keyword
 * — never an identifier, number, or closing bracket. Getting this wrong only
 * blanks the rest of a line (hiding a possible true positive), never invents
 * one.
 */
function startsRegexLiteral(source: string, index: number): boolean {
  const previous = previousSignificant(source, index);
  if (previous === undefined) return true;
  if ('=(,:[!&|?{;>+-*%~^'.includes(previous)) return true;
  return /(?:^|[^\w$])(?:return|typeof|case|in|of|delete|void|instanceof|new|do|else|yield|await)$/.test(
    source.slice(0, index).trimEnd(),
  );
}

/**
 * Blanks out string literals, regex literals and comments so the numeric scan
 * sees only code.
 *
 * A regex alone cannot tell a digit inside a string from one in code, so
 * `'utf-8'` was reported as the magic number 8, `'Node >= 23.4'` as 23.4, a doc
 * comment such as `Default: 400` as 400, and the character class `[^a-z0-9]` in
 * a regex as 9. Most reported violations were therefore false positives.
 *
 * Line structure (newlines) is preserved so reported line numbers stay correct.
 * The whole of a template literal is blanked, including any `${…}`
 * interpolation — a false negative is preferable to reporting prose.
 */
function blankStringsAndComments(source: string): string {
  const out = [...source];
  type Mode = 'code' | 'lineComment' | 'blockComment' | 'single' | 'double' | 'template';
  let mode: Mode = 'code';

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];

    if (mode === 'code') {
      if (char === '/' && next === '/') {
        mode = 'lineComment';
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 1;
      } else if (char === '/' && next === '*') {
        mode = 'blockComment';
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 1;
      } else if (char === '/' && startsRegexLiteral(source, i)) {
        // Blank the regex body on this line, honouring escapes and classes.
        let inClass = false;
        out[i] = ' ';
        for (i += 1; i < source.length && source[i] !== '\n'; i += 1) {
          const rc = source[i];
          out[i] = ' ';
          if (rc === '\\') {
            if (source[i + 1] !== undefined && source[i + 1] !== '\n') {
              out[i + 1] = ' ';
              i += 1;
            }
            continue;
          }
          if (rc === '[') inClass = true;
          else if (rc === ']') inClass = false;
          else if (rc === '/' && !inClass) break;
        }
      } else if (char === "'") {
        mode = 'single';
        out[i] = ' ';
      } else if (char === '"') {
        mode = 'double';
        out[i] = ' ';
      } else if (char === '`') {
        mode = 'template';
        out[i] = ' ';
      }
      continue;
    }

    if (mode === 'lineComment') {
      if (char === '\n') {
        mode = 'code';
        continue;
      }
      out[i] = ' ';
      continue;
    }

    if (mode === 'blockComment') {
      if (char === '*' && next === '/') {
        mode = 'code';
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 1;
      } else if (char !== '\n') {
        out[i] = ' ';
      }
      continue;
    }

    // Inside a string-like literal.
    if (char === '\\') {
      out[i] = ' ';
      if (next !== undefined) {
        if (next !== '\n') out[i + 1] = ' ';
        i += 1;
      }
      continue;
    }
    const closer = mode === 'single' ? "'" : mode === 'double' ? '"' : '`';
    if (char === closer) {
      mode = 'code';
      out[i] = ' ';
      continue;
    }
    if (char !== '\n') out[i] = ' ';
  }

  return out.join('');
}

/**
 * Flags unexplained numeric literals in code.
 *
 * Numbers assigned to a `SCREAMING_SNAKE_CASE` constant, and any digits inside
 * strings or comments, are ignored.
 */
export function noMagicNumbers(options: NoMagicNumbersOptions = {}): Check {
  const ignore = new Set<number>(options.ignore ?? [0, 1, -1, 2, 100]);
  const numericLit = /(?<![\w.])(-?\d+\.?\d*)(?![\w.])/g;
  const constDecl = /^\s*(?:export\s+)?(?:const|readonly)\s+[A-Z][A-Z_0-9]+\s*=/;

  return async (file) => {
    const violations: Violation[] = [];
    const lines = blankStringsAndComments(file.content).split('\n');

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? '';
      if (constDecl.test(line)) continue;

      numericLit.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = numericLit.exec(line)) !== null) {
        const value = Number.parseFloat(match[0] ?? '');
        if (!Number.isFinite(value) || ignore.has(value)) continue;
        violations.push({
          rule: 'no-magic-number',
          message:
            options.message ??
            `Magic number ${match[0]}. Extract to a named constant with a descriptive name.`,
          path: file.path,
          line: i + 1,
          severity: 'warn',
          source: 'core',
        });
      }
    }

    return violations.slice(0, MAX_REPORTED);
  };
}

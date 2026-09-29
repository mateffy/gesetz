import type { Check, Violation } from '@gesetz/core';

export interface NoMagicNumbersOptions {
  /** Numbers that are always allowed. Default: [0, 1, -1, 2, 100] */
  readonly ignore?: number[] | undefined;
  readonly message?: string | undefined;
}

interface Found {
  readonly text: string;
  readonly value: number;
  /** 1-indexed */
  readonly line: number;
}

/**
 * Collect numeric literals that are real code, in one pass over the file.
 *
 * The scan carries state across lines because a number is not a literal when it
 * sits inside a multi-line block comment or a multi-line template literal. A
 * per-line regex reported "Magic number 3" for the `3.` in a numbered doc list
 * and for `5-question` inside a template string.
 *
 * Known limit: text inside a template interpolation (`${x * 42}`) is skipped
 * along with the rest of the template. That errs towards silence.
 */
function findNumbers(content: string): Found[] {
  const out: Found[] = [];
  let line = 1;
  let i = 0;
  // 'code' | 'comment' | 'template' | 'regex' | a quote character
  let state: string = 'code';
  /** last significant character in code state, used to tell a regex from a division */
  let prev = '';

  while (i < content.length) {
    const c = content[i]!;
    const next = content[i + 1];

    if (c === '\n') {
      line++;
      i++;
      // a single-quoted string cannot legally span a line, so recover rather than
      // swallowing the rest of the file
      if (state === "'" || state === '"') state = 'code';
      continue;
    }

    if (state === 'comment') {
      if (c === '*' && next === '/') {
        state = 'code';
        i += 2;
      } else i++;
      continue;
    }
    if (state === 'regex') {
      if (c === '\\') i += 2;
      else if (c === '[') {
        // a character class can contain `/`, which does not end the regex
        i++;
        while (i < content.length && content[i] !== ']') {
          if (content[i] === '\\') i++;
          i++;
        }
        i++;
      } else if (c === '/') {
        state = 'code';
        i++;
      } else if (c === '\n') {
        state = 'code'; // a regex cannot span a line; recover
      } else i++;
      continue;
    }
    if (state === 'template') {
      if (c === '\\') i += 2;
      else if (c === '`') {
        state = 'code';
        i++;
      } else i++;
      continue;
    }
    if (state === "'" || state === '"') {
      if (c === '\\') i += 2;
      else if (c === state) {
        state = 'code';
        i++;
      } else i++;
      continue;
    }

    // state === 'code'
    if (c === '/' && next === '/') {
      const nl = content.indexOf('\n', i);
      i = nl < 0 ? content.length : nl;
      continue;
    }
    if (c === '/' && next === '*') {
      state = 'comment';
      i += 2;
      continue;
    }
    if (c === '/' && next !== '/' && next !== '*') {
      // A `/` is a regex when the previous significant character cannot end an
      // expression. Numbers inside a regex are pattern text, not literals —
      // `/[^a-z0-9\s-]/` reported "Magic number 9" and `[-=*]{5,}` reported 5.
      const before = content.slice(0, i).replace(/\s+$/, '');
      const keyword =
        /(?:\b(?:return|typeof|case|in|of|delete|void|instanceof|new|do|else|yield|await))$/.test(
          before,
        );
      if (prev === '' || /[(,=:[!&|?{};+\-*%~^<>]/.test(prev) || keyword) {
        state = 'regex';
        i++;
        continue;
      }
    }
    if (c === '`') {
      state = 'template';
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      state = c;
      i++;
      continue;
    }
    if (c === '#' && /(?:^|\n)\s*$/.test(content.slice(0, i))) {
      // a hash line comment (PHP, Python), but not a JS private field or `#!`
      const nl = content.indexOf('\n', i);
      i = nl < 0 ? content.length : nl;
      continue;
    }
    if (c >= '0' && c <= '9') {
      const before = content[i - 1] ?? ' ';
      if (/[\w$.]/.test(before)) {
        i++;
        continue;
      }
      let j = i;
      while (j < content.length && /[\d._]/.test(content[j]!)) j++;
      const text = content.slice(i, j).replace(/_/g, '');
      out.push({ text, value: Number(text), line });
      i = j;
      prev = '0';
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

/** Net () [] {} balance of a line, ignoring strings and comments. */
function balanceOf(line: string): number {
  let balance = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    const next = line[i + 1];
    if (c === '/' && next === '/') break;
    if (c === '/' && next === '*') break;
    if (c === "'" || c === '"' || c === '\u0060') break;
    if (c === '(' || c === '[' || c === '{') balance++;
    else if (c === ')' || c === ']' || c === '}') balance--;
  }
  return balance;
}

/**
 * A named binding, capturing what follows the `=`.
 *
 * The value is only "named" when the initialiser *is* a literal or a literal
 * structure — `const MAX = 3`, `const cols = { bar: 20 }`. In
 * `const r = value * 42` the 42 is buried in an expression and the binding does
 * not name it, so that line must still be scanned.
 */
const NAMED_BINDING =
  /^\s*(?:export\s+)?(?:const|let|var|readonly)\s+[\w$]+\s*(?::[^=]+)?=\s*([\s\S]*)$/;
const INITIALISER_IS_A_VALUE = /^(?:-?\d|[[{(]|'|"|\u0060)/;

/**
 * A default value in a binding position: `function f(width = 20)`,
 * `const { bonus = 5 } = scoring`. The preceding `{`, `(`, or `,` distinguishes a
 * binding from a plain assignment, so `x = 42` is still reported.
 */
const NAMED_DEFAULT = /[{,(]\s*[\w$]+\s*=\s*$/;

/**
 * One entry of a multi-line destructuring pattern: `bonus = 5,`.
 *
 * Such an entry starts its line, so there is no `{` or `,` to its left, and the
 * entry is separated from a plain assignment by its trailing comma — a statement
 * ends in `;`.
 */
const DESTRUCTURING_ENTRY = /^\s*[\w$]+\s*=\s*[\s\S]*,\s*$/;

/**
 * Flags unexplained numeric literals.
 *
 * A number is "explained" when the surrounding code names it:
 *
 *   - it initialises a named binding, including a multi-line object or array,
 *     because the binding name is the name (`const colWidths = { bar: 20 }`)
 *   - it is a default value for a named parameter, because the parameter name
 *     is the name (`function bar(score, width = 20)`)
 *
 * Numbers inside strings, template literals and comments are not literals at all
 * and are skipped.
 *
 * Two earlier behaviours were wrong in opposite directions. Only
 * SCREAMING_SNAKE_CASE bindings were exempt, so `const colWidths = { category: 14,
 * bar: 20 }` produced a violation for each named value; and the scan was per-line,
 * so numbered lists in docblocks and digits inside template strings were reported.
 * Output was also capped at twenty per file, so a file with forty hits looked the
 * same as one with twenty.
 */
export function noMagicNumbers(options: NoMagicNumbersOptions = {}): Check {
  const ignore = new Set<number>(options.ignore ?? [0, 1, -1, 2, 100]);

  return async (file) => {
    const lines = file.content.split('\n');
    const violations: Violation[] = [];

    /** lines whose numbers are already named, by line number */
    const named = new Set<number>();
    let openInitialiser = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (openInitialiser > 0) {
        named.add(i + 1);
        openInitialiser += balanceOf(line);
        continue;
      }
      const binding = NAMED_BINDING.exec(line);
      if (binding !== null && INITIALISER_IS_A_VALUE.test(binding[1] ?? '')) {
        named.add(i + 1);
        const balance = balanceOf(line);
        if (balance > 0) openInitialiser = balance;
      }
    }

    for (const found of findNumbers(file.content)) {
      if (!Number.isFinite(found.value) || ignore.has(found.value)) continue;
      if (named.has(found.line)) continue;
      const line = lines[found.line - 1] ?? '';
      if (DESTRUCTURING_ENTRY.test(line)) continue;
      const at = line.indexOf(found.text);
      if (at >= 0 && NAMED_DEFAULT.test(line.slice(0, at))) continue;
      violations.push({
        rule: 'no-magic-number',
        message:
          options.message ??
          `Magic number ${found.text}. Extract to a named constant with a descriptive name.`,
        path: file.path,
        line: found.line,
        severity: 'warn',
        source: 'core',
      });
    }
    return violations;
  };
}

import { describe, it, expect } from 'vitest';
import * as nodePath from 'node:path';
import { makeFile, makeCheckServices, runCheck } from '@gesetz/core';

import {
  noConsoleLog,
  noEmptyCatch,
  noMagicNumbers,
  noTrivialComment,
  relativeImports,
} from '../src';

const CWD = process.cwd();

// ─── Pure sync checks — need no services at all ─────────────────────────────

describe('noConsoleLog (moved from core)', () => {
  it('flags console.log', async () => {
    const v = await runCheck(
      noConsoleLog(),
      makeFile('src/foo.ts', 'console.log("hello");'),
      makeCheckServices(),
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.rule).toBe('no-console-log');
  });

  it('flags warn and error by default', async () => {
    const v = await runCheck(
      noConsoleLog(),
      makeFile('src/foo.ts', 'console.warn("w");\nconsole.error("e");'),
      makeCheckServices(),
    );
    expect(v).toHaveLength(2);
  });

  it('allows warn and error when allowWarnError is true', async () => {
    const v = await runCheck(
      noConsoleLog({ allowWarnError: true }),
      makeFile('src/foo.ts', 'console.warn("w");\nconsole.error("e");'),
      makeCheckServices(),
    );
    expect(v).toHaveLength(0);
  });
});

describe('noEmptyCatch (moved from core)', () => {
  it('flags empty catch block', async () => {
    const v = await runCheck(
      noEmptyCatch(),
      makeFile('src/foo.ts', 'try { x(); } catch { \n }'),
      makeCheckServices(),
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.rule).toBe('no-empty-catch');
  });

  it('passes when catch has a body', async () => {
    const v = await runCheck(
      noEmptyCatch(),
      makeFile('src/foo.ts', 'try {\n  x();\n} catch (e) {\n  log(e);\n}'),
      makeCheckServices(),
    );
    expect(v).toHaveLength(0);
  });
});

describe('noMagicNumbers (moved from core)', () => {
  it('flags unexplained numeric literals', async () => {
    const v = await runCheck(
      noMagicNumbers(),
      makeFile('src/foo.ts', 'const r = value * 42;'),
      makeCheckServices(),
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain('42');
  });

  it('ignores named constants and the default ignore list', async () => {
    const v = await runCheck(
      noMagicNumbers(),
      makeFile('src/foo.ts', 'const MAX_RETRIES = 3;\nreturn x === 0 || x === 1;'),
      makeCheckServices(),
    );
    expect(v).toHaveLength(0);
  });

  it('treats a camelCase binding as naming its value', async () => {
    // Regression: only SCREAMING_SNAKE_CASE bindings were exempt, so ordinary
    // camelCase constants were flagged — six violations for six named values.
    const v = await runCheck(
      noMagicNumbers(),
      makeFile('src/foo.ts', 'const colWidths = { category: 14, bar: 20, score: 6 };'),
      makeCheckServices(),
    );
    expect(v).toHaveLength(0);
  });

  it('exempts a multi-line named initialiser', async () => {
    const src = ['const cols = {', '  category: 14,', '  bar: 20,', '};'].join('\n');
    const v = await runCheck(noMagicNumbers(), makeFile('src/foo.ts', src), makeCheckServices());
    expect(v).toHaveLength(0);
  });

  it('still reports a literal in the statement after a named initialiser', async () => {
    const src = ['const cols = { bar: 20 };', 'const t = value * 37;'].join('\n');
    const v = await runCheck(noMagicNumbers(), makeFile('src/foo.ts', src), makeCheckServices());
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain('37');
  });

  it('treats a default parameter value as named by the parameter', async () => {
    const v = await runCheck(
      noMagicNumbers(),
      makeFile(
        'src/foo.ts',
        'function bar(score: number, width = 20): string { return String(score); }',
      ),
      makeCheckServices(),
    );
    expect(v).toHaveLength(0);
  });

  it('does not report numbers inside string literals', async () => {
    // Regression: 'utf-8' produced "Magic number 8".
    const v = await runCheck(
      noMagicNumbers(),
      makeFile('src/foo.ts', "const enc = 'utf-8';\nconst label = `v2.5`;"),
      makeCheckServices(),
    );
    expect(v).toHaveLength(0);
  });

  it('does not report numbers inside comments', async () => {
    const v = await runCheck(
      noMagicNumbers(),
      makeFile('src/foo.ts', '// retry 3 times\nconst x = 1; // 7 attempts'),
      makeCheckServices(),
    );
    expect(v).toHaveLength(0);
  });

  it('does not treat a digit inside an identifier as a literal', async () => {
    const v = await runCheck(
      noMagicNumbers(),
      makeFile('src/foo.ts', 'const b64 = base64Encode(x); const sha256 = hash(x);'),
      makeCheckServices(),
    );
    expect(v).toHaveLength(0);
  });

  it('is not capped at twenty violations', async () => {
    const lines = Array.from(
      { length: 25 },
      (_, i) => `const v${i} = compute(x) * ${30 + i};`,
    ).join('\n');
    const v = await runCheck(noMagicNumbers(), makeFile('src/foo.ts', lines), makeCheckServices());
    expect(v).toHaveLength(25);
  });

  it('does not report numbers in a multi-line block comment', async () => {
    // Regression: a per-line scan saw `* 3. For each ...` as code.
    const src = [
      '/**',
      ' * Steps:',
      ' * 3. For each rule, read the guidance',
      ' * 4. Apply the fix',
      ' */',
      'const x = 1;',
    ].join('\n');
    const v = await runCheck(noMagicNumbers(), makeFile('src/foo.ts', src), makeCheckServices());
    expect(v).toHaveLength(0);
  });

  it('does not report numbers inside a multi-line template literal', async () => {
    // Regression: `5-question wizard` inside a template string was reported.
    const src = [
      'const help = `',
      '  Interactive (5-question wizard)',
      '  gesetz check --since HEAD~5',
      '`;',
    ].join('\n');
    const v = await runCheck(noMagicNumbers(), makeFile('src/foo.ts', src), makeCheckServices());
    expect(v).toHaveLength(0);
  });

  it('recovers after a block comment ends', async () => {
    const src = ['/* 7 */', 'const x = value * 42;'].join('\n');
    const v = await runCheck(noMagicNumbers(), makeFile('src/foo.ts', src), makeCheckServices());
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain('42');
    expect(v[0]?.line).toBe(2);
  });

  it('does not report a number in a trailing line comment', async () => {
    const v = await runCheck(
      noMagicNumbers(),
      makeFile('src/foo.ts', 'const x = compute(y); // 7 attempts'),
      makeCheckServices(),
    );
    expect(v).toHaveLength(0);
  });

  it('reports the correct line in a multi-line file', async () => {
    const src = ['const a = 1;', 'const b = 2;', 'const c = compute(x) * 42;'].join('\n');
    const v = await runCheck(noMagicNumbers(), makeFile('src/foo.ts', src), makeCheckServices());
    expect(v).toHaveLength(1);
    expect(v[0]?.line).toBe(3);
  });

  it('does not report numbers inside a regex literal', async () => {
    // Regression: pattern text was scanned as code — `/[^a-z0-9\s-]/` reported 9.
    const src = [
      "const slug = s.replace(/[^a-z0-9\\s-]/g, '');",
      'const divider = /^\\s*\\/\\/\\s*[-=*]{5,}/;',
      'const hex = /0x[0-9a-f]{2}/g;',
    ].join('\n');
    const v = await runCheck(noMagicNumbers(), makeFile('src/foo.ts', src), makeCheckServices());
    expect(v).toHaveLength(0);
  });

  it('still reports a number after a division', async () => {
    // `/` after a value is division, not a regex, so the literal is real code.
    const v = await runCheck(
      noMagicNumbers(),
      makeFile('src/foo.ts', 'const rate = total / 42;'),
      makeCheckServices(),
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain('42');
  });

  it('treats a destructuring default as named', async () => {
    // Regression: `const { bonus = 5 } = scoring` reported 5, as did each
    // element of `thresholds = [1, 3, 5, 8]`.
    const src = ['const {', '  bonus = 5,', '  thresholds = [1, 3, 5, 8],', '} = scoring;'].join(
      '\n',
    );
    const v = await runCheck(noMagicNumbers(), makeFile('src/foo.ts', src), makeCheckServices());
    expect(v).toHaveLength(0);
  });

  it('still reports a plain assignment', async () => {
    const v = await runCheck(
      noMagicNumbers(),
      makeFile('src/foo.ts', 'retries = 42;'),
      makeCheckServices(),
    );
    expect(v).toHaveLength(1);
  });

  it('does not report a mention of console.log inside a comment', async () => {
    // Regression: this rule's own docblock example was reported as a violation.
    const v = await runCheck(
      noConsoleLog(),
      makeFile(
        'src/foo.ts',
        [
          '// e.g. "console.log(" matches but "notconsole.log(" does not',
          '/* console.log(1) */',
          ' * console.log(2)',
        ].join('\n'),
      ),
      makeCheckServices(),
    );
    expect(v).toHaveLength(0);
  });

  it('still reports a real call, including one before a trailing comment', async () => {
    const v = await runCheck(
      noConsoleLog(),
      makeFile('src/foo.ts', ['console.log(x);', 'console.info(y); // still a call'].join('\n')),
      makeCheckServices(),
    );
    expect(v).toHaveLength(2);
  });

  it('ignores the configured ignore list', async () => {
    const v = await runCheck(
      noMagicNumbers({ ignore: [42] }),
      makeFile('src/foo.ts', 'const x = value * 42;'),
      makeCheckServices(),
    );
    expect(v).toHaveLength(0);
  });
});

describe('noTrivialComment (moved from core)', () => {
  it('flags narrative comments', async () => {
    const v = await runCheck(
      noTrivialComment(),
      makeFile('src/foo.ts', '// Import the module\n// Define the component'),
      makeCheckServices(),
    );
    expect(v).toHaveLength(2);
    expect(v[0]?.rule).toBe('no-trivial-comment');
  });

  it('ignores meaningful comments', async () => {
    const v = await runCheck(
      noTrivialComment(),
      makeFile('src/foo.ts', '// This explains why we retry on ECONNRESET'),
      makeCheckServices(),
    );
    expect(v).toHaveLength(0);
  });
});

// ─── relativeImports — needs fs.exists ──────────────────────────────────────

describe('relativeImports (moved from core)', () => {
  it('passes when all relative imports resolve', async () => {
    const file = makeFile(
      'src/foo.ts',
      `import { x } from './bar';\nimport { y } from './baz/index';`,
    );
    const services = makeCheckServices({
      projectRoot: CWD,
      files: {
        [nodePath.resolve(CWD, 'src/bar.ts')]: '',
        [nodePath.resolve(CWD, 'src/baz/index.ts')]: '',
      },
    });
    const v = await runCheck(relativeImports(), file, services);
    expect(v).toHaveLength(0);
  });

  it('fails when a relative import does not resolve', async () => {
    const file = makeFile('src/foo.ts', `import { x } from './missing';`);
    const services = makeCheckServices({ projectRoot: CWD });
    const v = await runCheck(relativeImports(), file, services);
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain('./missing');
  });

  it('ignores non-relative imports', async () => {
    const file = makeFile('src/foo.ts', `import React from 'react';\nimport { z } from 'zod';`);
    const services = makeCheckServices({ projectRoot: CWD });
    const v = await runCheck(relativeImports(), file, services);
    expect(v).toHaveLength(0);
  });

  it('resolves .tsx extensions', async () => {
    const file = makeFile('src/foo.ts', `import { Comp } from './Comp';`);
    const services = makeCheckServices({
      projectRoot: CWD,
      files: { [nodePath.resolve(CWD, 'src/Comp.tsx')]: '' },
    });
    const v = await runCheck(relativeImports(), file, services);
    expect(v).toHaveLength(0);
  });
});

describe('noTrivialComment', () => {
  it('flags a short comment that restates the next line', async () => {
    const v = await runCheck(
      noTrivialComment(),
      makeFile(
        'src/foo.ts',
        ['// Check expiry', 'const expired = now > ttl;', '// Return JSX', 'return jsx;'].join(
          '\n',
        ),
      ),
      makeCheckServices(),
    );
    expect(v).toHaveLength(2);
    expect(v[0]?.severity).toBe('info');
  });

  it('leaves a comment that explains why', async () => {
    // Regression: any comment starting with one of the listed verbs was flagged,
    // so comments carrying a reason were reported as narration.
    const explains = [
      '// Set exit code without short-circuiting finalizers — lets the Effect runtime drain.',
      '// Filter on extension + raw type rather than a `gesetz-syntax.import` string.',
      '// Check if it contains JSX. ast-grep parses a fragment as an unnamed declaration.',
      '// Import edges resolved by netzwerk from import markers, so no re-parsing happens here.',
      '// Build a map: filePath -> layer name',
    ].join('\n');
    const v = await runCheck(
      noTrivialComment(),
      makeFile('src/foo.ts', explains),
      makeCheckServices(),
    );
    expect(v).toHaveLength(0);
  });

  it('leaves a long comment alone even without a reason marker', async () => {
    const v = await runCheck(
      noTrivialComment(),
      makeFile(
        'src/foo.ts',
        '// Build a map of testcase positions to the nearest preceding suite file for every case',
      ),
      makeCheckServices(),
    );
    expect(v).toHaveLength(0);
  });

  it('leaves section dividers alone', async () => {
    const v = await runCheck(
      noTrivialComment(),
      makeFile('src/foo.ts', ['// ───────────────', '// ==========', '// ************'].join('\n')),
      makeCheckServices(),
    );
    expect(v).toHaveLength(0);
  });

  it('does not flag a comment that is not a verb phrase', async () => {
    const v = await runCheck(
      noTrivialComment(),
      makeFile('src/foo.ts', '// the retry budget, in milliseconds'),
      makeCheckServices(),
    );
    expect(v).toHaveLength(0);
  });

  it('accepts a custom message', async () => {
    const v = await runCheck(
      noTrivialComment({ message: 'narrating' }),
      makeFile('src/foo.ts', '// Check expiry'),
      makeCheckServices(),
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toBe('narrating');
  });
});

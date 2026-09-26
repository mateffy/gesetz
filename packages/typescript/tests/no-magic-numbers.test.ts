import { describe, it, expect } from 'vitest';
import * as nodePath from 'node:path';
import { makeFile, makeCheckServices, runCheck } from '@gesetz/core';

import { noMagicNumbers } from '../src';

const CWD = process.cwd();

// ─── Pure sync checks — need no services at all ─────────────────────────────

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

  it('ignores the configured ignore list', async () => {
    const v = await runCheck(
      noMagicNumbers({ ignore: [42] }),
      makeFile('src/foo.ts', 'const x = value * 42;'),
      makeCheckServices(),
    );
    expect(v).toHaveLength(0);
  });
});

import { describe, it, expect } from 'vitest';
import * as nodePath from 'node:path';
import { makeFile, makeCheckServices, runCheck } from '@gesetz/core';

import { noTrivialComment } from '../src';

const CWD = process.cwd();

// ─── Pure sync checks — need no services at all ─────────────────────────────

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

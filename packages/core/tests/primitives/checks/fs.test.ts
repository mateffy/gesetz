import { describe, it, expect } from 'vitest';
import * as nodePath from 'node:path';
import { requireSibling, forbidFile, requireTest, testCandidates } from '../../../src/primitives/checks/fs';
import { makeFile, makeCheckServices, runCheck } from '../../../src/test-helpers';

const CWD = process.cwd();

describe('requireSibling', () => {
  it('passes when sibling exists', async () => {
    const file = makeFile('src/Button.tsx');
    const services = makeCheckServices({
      projectRoot: CWD,
      files: { [nodePath.resolve(CWD, 'src/Button.stories.tsx')]: '' },
    });
    const v = await runCheck(requireSibling('.stories.tsx'), file, services);
    expect(v).toHaveLength(0);
  });

  it('fails when sibling is missing', async () => {
    const file = makeFile('src/Button.tsx');
    const services = makeCheckServices({ projectRoot: CWD });
    const v = await runCheck(requireSibling('.stories.tsx'), file, services);
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain('Button.stories.tsx');
  });

  it('uses custom message when provided', async () => {
    const file = makeFile('src/Button.tsx');
    const services = makeCheckServices({ projectRoot: CWD });
    const v = await runCheck(requireSibling('.test.tsx', { message: 'Custom error message' }), file, services);
    expect(v[0]?.message).toBe('Custom error message');
  });
});

describe('forbidFile', () => {
  it('always returns a violation for the matched file', async () => {
    const v = await runCheck(forbidFile(), makeFile('src/legacy/old.ts'), makeCheckServices());
    expect(v).toHaveLength(1);
    expect(v[0]?.path).toBe('src/legacy/old.ts');
  });

  it('uses custom message', async () => {
    const v = await runCheck(forbidFile({ message: 'Do not use this file' }), makeFile('src/foo.ts'), makeCheckServices());
    expect(v[0]?.message).toBe('Do not use this file');
  });
});

describe('testCandidates', () => {
  const abs = (p: string): string => nodePath.resolve(CWD, p);

  it('always includes the co-located path', () => {
    expect(testCandidates(abs('src/a/b.ts'), ['.test.ts'])).toContain(abs('src/a/b.test.ts'));
  });

  it('includes the tests/ path, mirroring the path below src', () => {
    // This repository keeps tests in packages/<pkg>/tests/, mirroring src/.
    expect(testCandidates(abs('src/primitives/checks/fs.ts'), ['.test.ts']))
      .toContain(abs('tests/primitives/checks/fs.test.ts'));
  });

  it('includes the flattened tests/ path, for a file directly under src', () => {
    expect(testCandidates(abs('src/adapter.ts'), ['.test.ts'])).toContain(abs('tests/adapter.test.ts'));
  });

  it('offers every requested suffix', () => {
    const found = testCandidates(abs('src/a.ts'), ['.test.ts', '.spec.tsx']);
    expect(found.some((x) => x.endsWith('a.test.ts'))).toBe(true);
    expect(found.some((x) => x.endsWith('a.spec.tsx'))).toBe(true);
  });

  it('does not throw for a file with no extension', () => {
    expect(() => testCandidates(abs('src/Makefile'), ['.test.ts'])).not.toThrow();
  });

  it('falls back to co-located only when there is no package.json above', () => {
    const found = testCandidates('/definitely/not/a/project/src/a.ts', ['.test.ts']);
    expect(found).toEqual(['/definitely/not/a/project/src/a.test.ts']);
  });
});

describe('requireTest', () => {
  it('passes when the test sits next to the source', async () => {
    const v = await runCheck(
      requireTest(),
      makeFile('src/foo.ts'),
      makeCheckServices({ projectRoot: CWD, files: { [nodePath.resolve(CWD, 'src/foo.test.ts')]: '' } }),
    );
    expect(v).toHaveLength(0);
  });

  it('passes when the test sits in tests/, mirroring the src path', async () => {
    const v = await runCheck(
      requireTest(),
      makeFile('src/primitives/checks/foo.ts'),
      makeCheckServices({
        projectRoot: CWD,
        files: { [nodePath.resolve(CWD, 'tests/primitives/checks/foo.test.ts')]: '' },
      }),
    );
    expect(v).toHaveLength(0);
  });

  it('passes when the test sits flat in tests/', async () => {
    const v = await runCheck(
      requireTest(),
      makeFile('src/adapter.ts'),
      makeCheckServices({ projectRoot: CWD, files: { [nodePath.resolve(CWD, 'tests/adapter.test.ts')]: '' } }),
    );
    expect(v).toHaveLength(0);
  });

  it('fails when no test exists, and names where it looked', async () => {
    // Regression: this repository keeps tests in tests/, and requireSibling only
    // looked next to the source, so every adapter reported a missing test.
    const v = await runCheck(requireTest(), makeFile('src/foo.ts'), makeCheckServices({ projectRoot: CWD }));
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe('error');
    expect(v[0]?.message).toContain('No test file found for src/foo.ts');
    expect(v[0]?.message).toContain('foo.test.ts');
  });

  it('honours custom suffixes', async () => {
    const v = await runCheck(
      requireTest({ suffixes: ['.browser.test.ts'] }),
      makeFile('src/foo.ts'),
      makeCheckServices({ projectRoot: CWD, files: { [nodePath.resolve(CWD, 'tests/foo.browser.test.ts')]: '' } }),
    );
    expect(v).toHaveLength(0);
  });

  it('accepts a custom message and severity', async () => {
    const v = await runCheck(
      requireTest({ message: 'needs a test', severity: 'warn' }),
      makeFile('src/foo.ts'),
      makeCheckServices({ projectRoot: CWD }),
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toBe('needs a test');
    expect(v[0]?.severity).toBe('warn');
  });
});

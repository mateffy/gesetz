import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { DEFAULT_TEST_SUFFIXES, testFilesForPaths } from '../../src/backend/test-scope';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-test-scope-'));
  // `testCandidates` finds the package root by walking up for a package.json, so
  // the fixture has to look like a real package.
  await writeFile(nodePath.join(root, 'package.json'), '{"name":"fixture"}');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Creates the given project-relative files, so existence is real. */
const put = async (...paths: string[]): Promise<void> => {
  for (const path of paths) {
    const absolute = nodePath.join(root, path);
    await mkdir(nodePath.dirname(absolute), { recursive: true });
    await writeFile(absolute, '');
  }
};

const scope = async (input: { wanted: readonly string[]; cwd?: string }) =>
  testFilesForPaths({
    rootDir: root,
    cwd: input.cwd === undefined ? root : nodePath.join(root, input.cwd),
    wantedPaths: input.wanted,
    exists: async (path) => nodeFs.existsSync(nodePath.join(root, path)),
  });

describe('testFilesForPaths', () => {
  it('finds a co-located test', async () => {
    await put('src/a.ts', 'src/a.test.ts');
    expect(await scope({ wanted: ['src/a.ts'] })).toEqual(['src/a.test.ts']);
  });

  it('finds a test under a tests directory', async () => {
    await put('src/a.ts', 'tests/a.test.ts');
    expect(await scope({ wanted: ['src/a.ts'] })).toEqual(['tests/a.test.ts']);
  });

  it('finds a mirrored test under a tests directory', async () => {
    await put('src/deep/a.ts', 'tests/deep/a.test.ts');
    expect(await scope({ wanted: ['src/deep/a.ts'] })).toEqual(['tests/deep/a.test.ts']);
  });

  it('keeps a changed test file itself', async () => {
    // Its own "test of a test" does not exist, and skipping it would mean a
    // changed test was never executed.
    await put('src/a.test.ts');
    expect(await scope({ wanted: ['src/a.test.ts'] })).toEqual(['src/a.test.ts']);
  });

  it('matches every convention at once', async () => {
    await put('src/a.ts', 'src/a.spec.ts', 'src/a.test.tsx');
    expect(await scope({ wanted: ['src/a.ts'] })).toEqual(['src/a.spec.ts', 'src/a.test.tsx']);
  });

  it('returns null when the files in play have no tests', async () => {
    // Null, not []: the caller must skip the runner rather than run it with no
    // filters, which would execute the whole suite and cost what the project costs.
    await put('src/a.ts', 'src/b.test.ts');
    expect(await scope({ wanted: ['src/a.ts'] })).toBeNull();
  });

  it('returns null for nothing in play', async () => {
    await put('src/a.test.ts');
    expect(await scope({ wanted: [] })).toBeNull();
  });

  it('deduplicates a test shared by two sources', async () => {
    await put('src/a.ts', 'src/a.tsx', 'src/a.test.ts');
    expect(await scope({ wanted: ['src/a.ts', 'src/a.tsx'] })).toEqual(['src/a.test.ts']);
  });

  it('returns paths relative to the runner directory', async () => {
    // The tool is invoked from its own directory and matches filters against it.
    await put('immoui/src/a.ts', 'immoui/src/a.test.ts');
    expect(await scope({ wanted: ['immoui/src/a.ts'], cwd: 'immoui' })).toEqual(['src/a.test.ts']);
  });

  it('accepts a project-specific suffix list', async () => {
    await put('src/a.ts', 'src/a.test.ts', 'src/a.spec.ts');
    const files = await testFilesForPaths({
      rootDir: root,
      cwd: root,
      wantedPaths: ['src/a.ts'],
      suffixes: ['.spec.ts'],
      exists: async (path) => nodeFs.existsSync(nodePath.join(root, path)),
    });
    expect(files).toEqual(['src/a.spec.ts']);
  });

  it('knows the conventions this repository follows', () => {
    expect(DEFAULT_TEST_SUFFIXES).toContain('.test.ts');
    expect(DEFAULT_TEST_SUFFIXES).toContain('.test.tsx');
    expect(DEFAULT_TEST_SUFFIXES).toContain('.spec.ts');
    expect(DEFAULT_TEST_SUFFIXES).toContain('.test.php');
  });
});

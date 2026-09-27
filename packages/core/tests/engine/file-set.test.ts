import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { listFiles, treeStateFor, treeStatesMatch } from '../../src/engine/file-set';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-file-set-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const put = async (rel: string, content = 'x') => {
  const abs = nodePath.join(dir, rel);
  await mkdir(nodePath.dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
};

describe('treeStateFor', () => {
  it('records one entry per file, keyed by repo-relative path', async () => {
    await put('src/a.ts');
    await put('src/b.ts', 'longer content');
    const state = treeStateFor(dir);
    expect(Object.keys(state.statMap).sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('changes the fingerprint when a file is added, and the stat map too', async () => {
    await put('src/a.ts');
    const before = treeStateFor(dir);
    await put('src/b.ts');
    const after = treeStateFor(dir);
    expect(after.pathsFingerprint).not.toBe(before.pathsFingerprint);
    expect(after.statMap).not.toEqual(before.statMap);
  });

  it('changes the stat map when a file is rewritten, keeping the same paths', async () => {
    await put('src/a.ts', 'one');
    const before = treeStateFor(dir);
    await put('src/a.ts', 'a different length');
    const after = treeStateFor(dir);
    expect(after.pathsFingerprint).toBe(before.pathsFingerprint);
    expect(after.statMap).not.toEqual(before.statMap);
  });

  it('is stable for an unchanged tree', async () => {
    await put('src/a.ts');
    expect(treeStateFor(dir)).toEqual(treeStateFor(dir));
  });

  it('ignores the same directories the file set ignores', async () => {
    await put('src/a.ts');
    const before = treeStateFor(dir);
    await put('node_modules/pkg/index.js');
    await put('dist/out.js');
    expect(treeStateFor(dir)).toEqual(before);
  });

  it('records mtime and size, not content', async () => {
    await put('src/a.ts', 'abc');
    expect(treeStateFor(dir).statMap['src/a.ts']).toMatch(/^\d+:3$/);
  });
});

describe('treeStatesMatch', () => {
  it('matches two states of the same unchanged tree', async () => {
    await put('src/a.ts');
    expect(treeStatesMatch(treeStateFor(dir), treeStateFor(dir))).toBe(true);
  });

  it('does not match after a file is added', async () => {
    await put('src/a.ts');
    const before = treeStateFor(dir);
    await put('src/b.ts');
    expect(treeStatesMatch(before, treeStateFor(dir))).toBe(false);
  });

  it('does not match after a file is rewritten', async () => {
    await put('src/a.ts', 'one');
    const before = treeStateFor(dir);
    await put('src/a.ts', 'one but different');
    expect(treeStatesMatch(before, treeStateFor(dir))).toBe(false);
  });

  it('does not match when the path sets differ but the file count is equal', async () => {
    // A rename must not look like "nothing changed": same count, different paths.
    await put('src/a.ts');
    const before = treeStateFor(dir);
    await rm(nodePath.join(dir, 'src/a.ts'));
    await put('src/b.ts');
    expect(treeStatesMatch(before, treeStateFor(dir))).toBe(false);
  });

  it('does not match two states with the same paths but different sizes', () => {
    const a = { pathsFingerprint: 'same', statMap: { 'src/a.ts': '1:10' } };
    const b = { pathsFingerprint: 'same', statMap: { 'src/a.ts': '1:99' } };
    expect(treeStatesMatch(a, b)).toBe(false);
  });
});

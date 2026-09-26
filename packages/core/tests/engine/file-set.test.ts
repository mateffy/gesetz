import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { fileSetFingerprint } from '../../src/engine/file-set';

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

describe('fileSetFingerprint', () => {
  it('is stable for an unchanged tree', async () => {
    await put('src/a.ts');
    expect(fileSetFingerprint(dir)).toBe(fileSetFingerprint(dir));
  });

  it('changes when a file is added', async () => {
    await put('src/a.ts');
    const before = fileSetFingerprint(dir);
    await put('src/a.test.ts');
    expect(fileSetFingerprint(dir)).not.toBe(before);
  });

  it('changes when a file is removed', async () => {
    await put('src/a.ts');
    await put('src/b.ts');
    const before = fileSetFingerprint(dir);
    await rm(nodePath.join(dir, 'src/b.ts'));
    expect(fileSetFingerprint(dir)).not.toBe(before);
  });

  it('does not change when only a file changes content', async () => {
    // Contents are hashed per file already; this fingerprint is about the set.
    await put('src/a.ts', 'export const a = 1;');
    const before = fileSetFingerprint(dir);
    await put('src/a.ts', 'export const a = 2;');
    expect(fileSetFingerprint(dir)).toBe(before);
  });

  it('is independent of directory entry order', async () => {
    await put('src/z.ts');
    await put('src/a.ts');
    const first = fileSetFingerprint(dir);
    await rm(nodePath.join(dir, 'src/z.ts'));
    await rm(nodePath.join(dir, 'src/a.ts'));
    await put('src/a.ts');
    await put('src/z.ts');
    expect(fileSetFingerprint(dir)).toBe(first);
  });

  it('ignores node_modules, which would otherwise swamp it', async () => {
    await put('src/a.ts');
    const before = fileSetFingerprint(dir);
    await put('node_modules/pkg/index.js');
    expect(fileSetFingerprint(dir)).toBe(before);
  });

  it('ignores build output and the cache directory', async () => {
    await put('src/a.ts');
    const before = fileSetFingerprint(dir);
    await put('dist/index.js');
    await put('.gesetz/cache.db');
    await put('coverage/lcov.info');
    expect(fileSetFingerprint(dir)).toBe(before);
  });

  it('notices a file in a directory it does not skip', async () => {
    await put('src/a.ts');
    const before = fileSetFingerprint(dir);
    await put('tests/a.test.ts');
    expect(fileSetFingerprint(dir)).not.toBe(before);
  });

  it('is a hex digest rather than the paths themselves', async () => {
    await put('src/a.ts');
    const fingerprint = fileSetFingerprint(dir);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint).not.toContain('src/a.ts');
  });

  it('returns a fingerprint for a directory with no files', async () => {
    expect(fileSetFingerprint(dir)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns a fingerprint for a directory that does not exist', () => {
    // A walk that cannot read its root yields the empty set rather than throwing.
    expect(fileSetFingerprint(nodePath.join(dir, 'nope'))).toMatch(/^[0-9a-f]{64}$/);
  });
});

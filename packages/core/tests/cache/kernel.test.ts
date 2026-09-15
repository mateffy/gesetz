import { mkdtemp, rm, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sync } from '../../src/cache/kernel';
import { createMemoryStore } from '../../src/cache/store-memory';
import type { FileRef } from '../../src/cache/types';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-cache-kernel-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function refs(...names: string[]): FileRef[] {
  return names.map((name) => ({ path: name, absolutePath: nodePath.join(dir, name) }));
}

async function write(name: string, content: string): Promise<void> {
  await writeFile(nodePath.join(dir, name), content, 'utf8');
}

describe('cache sync kernel', () => {
  it('computes added files on a cold cache', async () => {
    await write('a.ts', 'a');
    await write('b.ts', 'b');
    const store = createMemoryStore();
    const result = await sync({
      scope: 's',
      store,
      files: refs('a.ts', 'b.ts'),
      compute: async (_file, source) => source.content.toUpperCase(),
    });
    expect([...result.added].sort()).toEqual(['a.ts', 'b.ts']);
    expect(result.changed).toEqual([]);
    expect(result.reused).toEqual([]);
    expect(result.values.get('a.ts')).toBe('A');
    expect(result.hashes.get('b.ts')).toBeDefined();
  });

  it('reuses unchanged files without calling compute', async () => {
    await write('a.ts', 'a');
    const store = createMemoryStore();
    let calls = 0;
    const compute = async (): Promise<string> => {
      calls += 1;
      return 'value';
    };
    await sync({ scope: 's', store, files: refs('a.ts'), compute });
    const second = await sync({ scope: 's', store, files: refs('a.ts'), compute });
    expect(calls).toBe(1);
    expect(second.reused).toEqual(['a.ts']);
    expect(second.added).toEqual([]);
    expect(second.values.get('a.ts')).toBe('value');
  });

  it('recomputes changed files and reports them', async () => {
    await write('a.ts', 'a');
    const store = createMemoryStore();
    const compute = async (_file: FileRef, source: { content: string }): Promise<string> =>
      source.content;
    await sync({ scope: 's', store, files: refs('a.ts'), compute });
    await write('a.ts', 'a2');
    const second = await sync({ scope: 's', store, files: refs('a.ts'), compute });
    expect(second.changed).toEqual(['a.ts']);
    expect(second.values.get('a.ts')).toBe('a2');
  });

  it('removes entries for files that no longer exist', async () => {
    await write('a.ts', 'a');
    await write('b.ts', 'b');
    const store = createMemoryStore();
    const compute = async (_file: FileRef, source: { content: string }): Promise<string> =>
      source.content;
    await sync({ scope: 's', store, files: refs('a.ts', 'b.ts'), compute });
    await unlink(nodePath.join(dir, 'b.ts'));
    const second = await sync({ scope: 's', store, files: refs('a.ts'), compute });
    expect(second.removed).toEqual(['b.ts']);
    expect((await store.entries('s')).has('b.ts')).toBe(false);
  });

  it('skips files that vanished between discovery and reading', async () => {
    await write('a.ts', 'a');
    const store = createMemoryStore();
    const compute = async (_file: FileRef, source: { content: string }): Promise<string> =>
      source.content;
    // Discovered but never written — simulates `git ls-files --cached` listing a
    // file that was deleted from the working tree.
    const files = refs('a.ts', 'gone.ts');
    const second = await sync({ scope: 's', store, files, compute });
    expect(second.removed).toEqual([]);
    expect(second.values.has('gone.ts')).toBe(false);
    expect((await store.entries('s')).has('gone.ts')).toBe(false);
  });

  it('recomputes everything when the fingerprint changes', async () => {
    await write('a.ts', 'a');
    const store = createMemoryStore();
    let calls = 0;
    const compute = async (): Promise<string> => {
      calls += 1;
      return 'value';
    };
    await sync({ scope: 's', store, files: refs('a.ts'), fingerprint: 'v1', compute });
    const second = await sync({
      scope: 's',
      store,
      files: refs('a.ts'),
      fingerprint: 'v2',
      compute,
    });
    expect(calls).toBe(2);
    expect(second.changed).toEqual(['a.ts']);
  });

  it('force recomputes despite an unchanged hash', async () => {
    await write('a.ts', 'a');
    const store = createMemoryStore();
    let calls = 0;
    const compute = async (): Promise<string> => {
      calls += 1;
      return 'value';
    };
    await sync({ scope: 's', store, files: refs('a.ts'), compute });
    await sync({ scope: 's', store, files: refs('a.ts'), force: true, compute });
    expect(calls).toBe(2);
  });

  it('accepts a custom reader', async () => {
    await write('a.ts', 'a');
    const store = createMemoryStore();
    const result = await sync({
      scope: 's',
      store,
      files: refs('a.ts'),
      read: async (file) => ({ content: `custom:${file.path}`, hash: 'fixed' }),
      compute: async (_file, source) => source.content,
    });
    expect(result.values.get('a.ts')).toBe('custom:a.ts');
  });
});

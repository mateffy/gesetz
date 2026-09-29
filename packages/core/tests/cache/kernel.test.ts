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

describe('the stamp fast path', () => {
  /**
   * Counts how many times the kernel actually read a file.
   *
   * The point of the stamp is that a warm run does not read the project at all:
   * hashing 700 MB every run cost 32 seconds in the repository this was measured
   * on.
   */
  const countingReader = (reads: { count: number }) => async (file: FileRef) => {
    reads.count += 1;
    const { readFile } = await import('node:fs/promises');
    const bytes = await readFile(file.absolutePath);
    const { hashBytes } = await import('../../src/cache/hash');
    return { content: bytes.toString('utf8'), hash: hashBytes(bytes) };
  };

  it('does not read a file whose stamp is unchanged', async () => {
    await write('a.ts', 'a');
    const store = createMemoryStore();
    const reads = { count: 0 };
    const options = {
      scope: 's',
      store,
      files: refs('a.ts'),
      read: countingReader(reads),
      compute: async (_file: FileRef, source: { content: string }) => source.content,
    };

    await sync(options);
    expect(reads.count).toBe(1);

    const second = await sync(options);
    expect(second.reused).toEqual(['a.ts']);
    expect(reads.count).toBe(1); // no read at all on the warm run
  });

  it('reads but does not recompute when only the mtime moved', async () => {
    await write('a.ts', 'a');
    const store = createMemoryStore();
    let computed = 0;
    const options = {
      scope: 's',
      store,
      files: refs('a.ts'),
      compute: async (_file: FileRef, source: { content: string }) => {
        computed += 1;
        return source.content;
      },
    };
    await sync(options);

    // Touch the file: same bytes, new mtime.
    const now = Date.now() / 1000 + 10;
    const { utimes } = await import('node:fs/promises');
    await utimes(nodePath.join(dir, 'a.ts'), now, now);

    const second = await sync(options);
    expect(second.reused).toEqual(['a.ts']);
    expect(computed).toBe(1); // content was re-hashed, the computation was not repeated
  });

  it('recomputes when the content changes, however small', async () => {
    await write('a.ts', 'a');
    const store = createMemoryStore();
    const options = {
      scope: 's',
      store,
      files: refs('a.ts'),
      compute: async (_file: FileRef, source: { content: string }) => source.content,
    };
    await sync(options);

    await write('a.ts', 'b');
    const second = await sync(options);
    expect(second.changed).toEqual(['a.ts']);
    expect(second.values.get('a.ts')).toBe('b');
  });

  it('ignores the stamp when the scope is invalidated', async () => {
    await write('a.ts', 'a');
    const store = createMemoryStore();
    let computed = 0;
    const options = (fingerprint: string) => ({
      scope: 's',
      store,
      files: refs('a.ts'),
      fingerprint,
      compute: async (_file: FileRef, source: { content: string }) => {
        computed += 1;
        return source.content;
      },
    });

    await sync(options('v1'));
    await sync(options('v2'));
    expect(computed).toBe(2);
  });
});

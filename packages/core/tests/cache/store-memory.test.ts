import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '../../src/cache/store-memory';

describe('createMemoryStore', () => {
  it('stores and reads entries per scope', async () => {
    const store = createMemoryStore();
    await store.put('a', 'x.ts', { hash: 'h1', value: [1] });
    await store.put('b', 'x.ts', { hash: 'h2', value: [2] });
    expect(await store.get('a', 'x.ts')).toEqual({ hash: 'h1', value: [1] });
    expect(await store.get('b', 'x.ts')).toEqual({ hash: 'h2', value: [2] });
    expect(await store.get('a', 'missing.ts')).toBeUndefined();
  });

  it('lists entries for a scope', async () => {
    const store = createMemoryStore();
    await store.put('a', 'x.ts', { hash: 'h1', value: 1 });
    await store.put('a', 'y.ts', { hash: 'h2', value: 2 });
    await store.put('b', 'z.ts', { hash: 'h3', value: 3 });
    expect([...(await store.entries('a')).keys()].sort()).toEqual(['x.ts', 'y.ts']);
    expect((await store.entries('b')).size).toBe(1);
  });

  it('prunes only paths not in keep', async () => {
    const store = createMemoryStore();
    await store.put('a', 'x.ts', { hash: 'h1', value: 1 });
    await store.put('a', 'y.ts', { hash: 'h2', value: 2 });
    const removed = await store.prune('a', new Set(['x.ts']));
    expect(removed).toEqual(['y.ts']);
    expect((await store.entries('a')).size).toBe(1);
  });

  it('deletes a single entry', async () => {
    const store = createMemoryStore();
    await store.put('a', 'x.ts', { hash: 'h1', value: 1 });
    await store.delete('a', 'x.ts');
    expect(await store.get('a', 'x.ts')).toBeUndefined();
    // Deleting a missing entry is a no-op.
    await store.delete('a', 'nope.ts');
    await store.delete('missing-scope', 'x.ts');
  });
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSqliteStore } from '../../src/cache/store-sqlite';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-cache-sqlite-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('createSqliteStore', () => {
  it('persists entries across store instances', async () => {
    const path = nodePath.join(dir, 'cache.db');
    const first = await createSqliteStore(path);
    await first.put('rule-a', 'x.ts', {
      hash: 'h1',
      value: [{ message: 'boom', path: 'x.ts' }],
      meta: { fingerprint: 'fp1' },
    });
    await first.close();

    const second = await createSqliteStore(path);
    const entry = await second.get<{ message: string; path: string }[]>('rule-a', 'x.ts');
    expect(entry?.hash).toBe('h1');
    expect(entry?.meta?.['fingerprint']).toBe('fp1');
    expect(entry?.value[0]?.message).toBe('boom');
    await second.close();
  });

  it('reads a row with no usable hash as a miss, not as an entry', async () => {
    // A row can exist without a usable hash: a writer that only claimed the key, a
    // schema from an older version, a half-written value. Every one of those has to
    // read as "not cached" so the value is recomputed — never as an entry, and
    // never as a crash.
    const store = await createSqliteStore(nodePath.join(dir, 'cache.db'));
    await store.put('a', 'x.ts', { hash: '', value: { message: 'stale' } });
    expect(await store.get('a', 'x.ts')).toBeUndefined();
    expect([...(await store.entries('a')).keys()]).toEqual([]);
    await store.close();
  });

  it('overwrites an existing entry on put', async () => {
    const store = await createSqliteStore(nodePath.join(dir, 'cache.db'));
    await store.put('a', 'x.ts', { hash: 'h1', value: 1 });
    await store.put('a', 'x.ts', { hash: 'h2', value: 2 });
    expect(await store.get('a', 'x.ts')).toEqual({ hash: 'h2', value: 2 });
    await store.close();
  });

  it('prunes paths not in keep', async () => {
    const store = await createSqliteStore(nodePath.join(dir, 'cache.db'));
    await store.put('a', 'x.ts', { hash: 'h1', value: 1 });
    await store.put('a', 'y.ts', { hash: 'h2', value: 2 });
    await store.put('b', 'x.ts', { hash: 'h1', value: 3 });

    expect([...(await store.prune('a', new Set(['x.ts'])))].sort()).toEqual(['y.ts']);
    expect((await store.entries('a')).size).toBe(1);
    expect((await store.entries('b')).size).toBe(1);
    await store.close();
  });

  it('deletes a single entry', async () => {
    const store = await createSqliteStore(nodePath.join(dir, 'cache.db'));
    await store.put('a', 'x.ts', { hash: 'h1', value: 1 });
    await store.delete('a', 'x.ts');
    expect(await store.get('a', 'x.ts')).toBeUndefined();
    await store.close();
  });

  it('keeps namespaces isolated inside one shared file', async () => {
    const path = nodePath.join(dir, 'shared.db');
    const a = await createSqliteStore(path, { namespace: '/projects/a' });
    const b = await createSqliteStore(path, { namespace: '/projects/b' });

    await a.put('rules', 'src/x.ts', { hash: 'h1', value: 'from-a' });
    await b.put('rules', 'src/x.ts', { hash: 'h2', value: 'from-b' });

    expect((await a.get('rules', 'src/x.ts'))?.value).toBe('from-a');
    expect((await b.get('rules', 'src/x.ts'))?.value).toBe('from-b');

    // Pruning one project must not touch the other.
    expect(await a.prune('rules', new Set())).toEqual(['src/x.ts']);
    expect((await a.entries('rules')).size).toBe(0);
    expect((await b.entries('rules')).size).toBe(1);

    await a.close();
    await b.close();
  });

  it('sweeps entries older than the ttl when opening', async () => {
    const path = nodePath.join(dir, 'cache.db');
    const first = await createSqliteStore(path, { ttlMs: 1 });
    await first.put('rules', 'stale.ts', { hash: 'h1', value: 1 });
    await first.close();

    await new Promise((resolve) => setTimeout(resolve, 10));

    const second = await createSqliteStore(path, { ttlMs: 1 });
    expect(await second.get('rules', 'stale.ts')).toBeUndefined();
    await second.close();
  });

  it('does not sweep when the ttl is disabled', async () => {
    const path = nodePath.join(dir, 'cache.db');
    const first = await createSqliteStore(path, { ttlMs: 0 });
    await first.put('rules', 'kept.ts', { hash: 'h1', value: 1 });
    await first.close();

    await new Promise((resolve) => setTimeout(resolve, 10));

    const second = await createSqliteStore(path, { ttlMs: 0 });
    expect((await second.get('rules', 'kept.ts'))?.value).toBe(1);
    await second.close();
  });

  it('recreates the table when an older schema version is found', async () => {
    const path = nodePath.join(dir, 'legacy.db');
    const { DatabaseSync } = (await import('node:sqlite')) as unknown as {
      DatabaseSync: new (p: string) => { exec(sql: string): void; close(): void };
    };
    const legacy = new DatabaseSync(path);
    // The pre-shared-cache layout: no `workdir` column, user_version 1.
    legacy.exec(
      `CREATE TABLE cache_entries (
         scope TEXT NOT NULL, path TEXT NOT NULL, hash TEXT NOT NULL,
         fingerprint TEXT, value TEXT NOT NULL, updated_at INTEGER NOT NULL,
         PRIMARY KEY (scope, path))`,
    );
    legacy.exec('PRAGMA user_version = 1');
    legacy.close();

    const store = await createSqliteStore(path);
    await store.put('rules', 'a.ts', { hash: 'h1', value: 'ok' });
    expect((await store.get('rules', 'a.ts'))?.value).toBe('ok');
    await store.close();
  });
});

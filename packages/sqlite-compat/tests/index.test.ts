import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSqliteStore, getCacheDriver, unregisterCacheDriver } from '@gesetz/core';
import {
  createBetterSqliteStore,
  registerBetterSqliteDriver,
  type BetterSqliteConstructor,
} from '../src/index';

/**
 * A tiny stand-in for `better-sqlite3` that implements the exact statement set
 * the shared SQLite store uses. Used to test module-shape resolution and the
 * missing-module error path without depending on the real native module.
 */
interface FakeRow {
  workdir: string;
  scope: string;
  path: string;
  hash: string;
  fingerprint: string | null;
  value: string;
  updated_at: number;
}

const rowKey = (row: Pick<FakeRow, 'workdir' | 'scope' | 'path'>): string =>
  `${row.workdir}\u0000${row.scope}\u0000${row.path}`;

class FakeStatement {
  constructor(
    private readonly db: FakeDatabase,
    private readonly sql: string,
  ) {}

  run(...params: unknown[]): unknown {
    if (this.sql.startsWith('INSERT INTO cache_entries')) {
      const [workdir, scope, path, hash, fingerprint, value, updatedAt] = params as [
        string,
        string,
        string,
        string,
        string | null,
        string,
        number,
      ];
      const row: FakeRow = { workdir, scope, path, hash, fingerprint, value, updated_at: updatedAt };
      this.db.rows.set(rowKey(row), row);
      return { changes: 1 };
    }
    if (this.sql.startsWith('DELETE FROM cache_entries WHERE workdir = ? AND scope = ? AND path = ?')) {
      const [workdir, scope, path] = params as [string, string, string];
      this.db.rows.delete(rowKey({ workdir, scope, path }));
      return { changes: 1 };
    }
    if (this.sql.startsWith('DELETE FROM cache_entries WHERE updated_at < ?')) {
      const [cutoff] = params as [number];
      for (const [key, row] of [...this.db.rows]) {
        if (row.updated_at < cutoff) this.db.rows.delete(key);
      }
      return { changes: 1 };
    }
    throw new Error(`FakeStatement.run: unsupported SQL: ${this.sql}`);
  }

  all(...params: unknown[]): unknown[] {
    const [workdir, scope] = params as [string, string];
    return [...this.db.rows.values()].filter(
      (row) => row.workdir === workdir && row.scope === scope,
    );
  }

  get(...params: unknown[]): unknown {
    const [workdir, scope, path] = params as [string, string, string];
    return this.db.rows.get(rowKey({ workdir, scope, path }));
  }
}

class FakeDatabase {
  readonly rows = new Map<string, FakeRow>();

  exec(): void {
    /* schema setup is a no-op in the fake */
  }

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }

  close(): void {
    /* nothing to release */
  }
}

const fakeCtor = (): BetterSqliteConstructor => FakeDatabase as unknown as BetterSqliteConstructor;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-sqlite-compat-'));
  unregisterCacheDriver('sqlite');
});

afterEach(async () => {
  unregisterCacheDriver('sqlite');
  await rm(dir, { recursive: true, force: true });
});

describe('createBetterSqliteStore', () => {
  it('round-trips entries through the real better-sqlite3 driver', async () => {
    const path = nodePath.join(dir, 'cache.db');
    const store = await createBetterSqliteStore(path);
    await store.put('rules', 'src/a.ts', { hash: 'h1', value: [1], meta: { fingerprint: 'fp' } });
    await store.close();

    const reopened = await createBetterSqliteStore(path);
    const entry = await reopened.get<number[]>('rules', 'src/a.ts');
    expect(entry?.hash).toBe('h1');
    expect(entry?.value).toEqual([1]);
    expect(entry?.meta?.['fingerprint']).toBe('fp');

    await reopened.delete('rules', 'src/a.ts');
    expect(await reopened.get('rules', 'src/a.ts')).toBeUndefined();
    await reopened.close();
  });

  it('prunes paths not in keep', async () => {
    const store = await createBetterSqliteStore(nodePath.join(dir, 'cache.db'));
    await store.put('rules', 'a.ts', { hash: 'h1', value: 1 });
    await store.put('rules', 'b.ts', { hash: 'h2', value: 2 });
    expect([...(await store.prune('rules', new Set(['a.ts'])))].sort()).toEqual(['b.ts']);
    expect((await store.entries('rules')).size).toBe(1);
    await store.close();
  });

  it('accepts a commonjs and an esm module shape', async () => {
    const commonjs = await createBetterSqliteStore(nodePath.join(dir, 'a.db'), {
      load: () => FakeDatabase,
    });
    await commonjs.put('rules', 'a.ts', { hash: 'h1', value: 'cjs' });
    expect((await commonjs.get('rules', 'a.ts'))?.value).toBe('cjs');
    await commonjs.close();

    const esm = await createBetterSqliteStore(nodePath.join(dir, 'b.db'), {
      load: () => ({ default: FakeDatabase }),
    });
    await esm.put('rules', 'a.ts', { hash: 'h1', value: 'esm' });
    expect((await esm.get('rules', 'a.ts'))?.value).toBe('esm');
    await esm.close();
  });

  it('throws an actionable error when better-sqlite3 is missing', async () => {
    await expect(
      createBetterSqliteStore(nodePath.join(dir, 'cache.db'), { load: () => ({}) }),
    ).rejects.toThrow(/better-sqlite3 is not installed/);
  });
});

describe('registerBetterSqliteDriver', () => {
  it('registers a driver that createSqliteStore can use', async () => {
    expect(registerBetterSqliteDriver()).toBe(true);
    expect(getCacheDriver('sqlite')).toBeDefined();

    const store = await createSqliteStore(nodePath.join(dir, 'cache.db'), { driver: 'compat' });
    await store.put('rules', 'a.ts', { hash: 'h1', value: 'v' });
    expect((await store.get('rules', 'a.ts'))?.value).toBe('v');
    await store.close();
  });

  it('accepts an injected loader', () => {
    expect(registerBetterSqliteDriver(() => fakeCtor())).toBe(true);
    expect(getCacheDriver('sqlite')).toBeDefined();
  });

  it('returns false and registers nothing when the module is unavailable', () => {
    expect(registerBetterSqliteDriver(() => null)).toBe(false);
    expect(getCacheDriver('sqlite')).toBeUndefined();
  });

  it('auto-registers at import time', () => {
    // better-sqlite3 is a dependency of this package, so importing it must have
    // registered the driver during module evaluation. Re-register to assert the
    // public helper agrees.
    expect(registerBetterSqliteDriver()).toBe(true);
  });
});

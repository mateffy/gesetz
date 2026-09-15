import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getCacheDriver,
  registerCacheDriver,
  unregisterCacheDriver,
} from '../../src/cache/drivers';
import {
  createSqliteStore,
  isNodeSqliteAvailable,
  sqliteUnavailableMessage,
  SQLITE_COMPAT_PACKAGE,
  SqliteUnavailableError,
} from '../../src/cache/store-sqlite';
import { createMemoryStore } from '../../src/cache/store-memory';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-cache-drivers-'));
  unregisterCacheDriver('sqlite');
});

afterEach(async () => {
  unregisterCacheDriver('sqlite');
  await rm(dir, { recursive: true, force: true });
});

describe('cache driver registry', () => {
  it('registers, returns, and unregisters a driver', () => {
    const factory = async (): Promise<ReturnType<typeof createMemoryStore>> => createMemoryStore();
    expect(getCacheDriver('sqlite')).toBeUndefined();
    registerCacheDriver('sqlite', factory);
    expect(getCacheDriver('sqlite')).toBe(factory);
    unregisterCacheDriver('sqlite');
    expect(getCacheDriver('sqlite')).toBeUndefined();
  });
});

describe('createSqliteStore driver selection', () => {
  it('uses a registered driver when asked for the compat driver', async () => {
    const memory = createMemoryStore();
    registerCacheDriver('sqlite', async () => memory);
    const store = await createSqliteStore(nodePath.join(dir, 'ignored.db'), { driver: 'compat' });
    expect(store).toBe(memory);
  });

  it('throws an actionable error when the compat driver is not registered', async () => {
    await expect(
      createSqliteStore(nodePath.join(dir, 'cache.db'), { driver: 'compat' }),
    ).rejects.toBeInstanceOf(SqliteUnavailableError);
  });

  it('falls back to a registered driver in auto mode when node:sqlite exists', async () => {
    // node:sqlite wins in auto mode; the registered driver is only a fallback.
    const memory = createMemoryStore();
    registerCacheDriver('sqlite', async () => memory);
    const store = await createSqliteStore(nodePath.join(dir, 'cache.db'), { driver: 'auto' });
    if (await isNodeSqliteAvailable()) {
      expect(store).not.toBe(memory);
      await store.close();
    } else {
      expect(store).toBe(memory);
    }
  });

  it('creates a working store with the built-in driver', async () => {
    if (!(await isNodeSqliteAvailable())) return;
    const store = await createSqliteStore(nodePath.join(dir, 'cache.db'), { driver: 'node' });
    await store.put('rules', 'a.ts', { hash: 'h1', value: [1] });
    expect(await store.get('rules', 'a.ts')).toEqual({ hash: 'h1', value: [1] });
    await store.close();
  });
});

describe('sqliteUnavailableMessage', () => {
  it('names the compat package and the supported Node versions', () => {
    const message = sqliteUnavailableMessage();
    expect(message).toContain(SQLITE_COMPAT_PACKAGE);
    expect(message).toContain('23.4');
    expect(message).toContain('--experimental-sqlite');
    expect(message).toContain('will not persist a cache');
    expect(message).toContain('gesetz.config.ts');
  });

  it('is the default message of SqliteUnavailableError', () => {
    expect(new SqliteUnavailableError().message).toBe(sqliteUnavailableMessage());
  });
});

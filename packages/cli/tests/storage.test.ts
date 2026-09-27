import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { RUNTIME, describeStorage, resolveStorage } from '../src/storage';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-storage-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('resolveStorage', () => {
  it('uses the project-local cache database by default', () => {
    expect(resolveStorage(root, false)).toEqual({
      kind: 'sqlite',
      path: nodePath.join(root, '.gesetz', 'cache.db'),
    });
  });

  it('creates the cache directory, so the first scan can write there', () => {
    resolveStorage(root, false);
    expect(nodeFs.existsSync(nodePath.join(root, '.gesetz'))).toBe(true);
  });

  it('resolves the same storage whatever the runtime is', () => {
    // The cache used to be disabled under Bun on the grounds that better-sqlite3
    // is unsupported there. netzwerk uses @libsql/client, which works under Bun,
    // and agents invoke `bun node_modules/.bin/gesetz` — so that guard turned
    // every agent run into a full cold run. There is no runtime branch here any
    // more, and this test is what says so.
    const storage = resolveStorage(root, false);
    expect(storage.kind).toBe('sqlite');
  });

  it('uses in-memory storage when --full asks for no cache', () => {
    expect(resolveStorage(root, true)).toEqual({ kind: 'memory' });
  });

  it('honours GESETZ_DB', () => {
    const previous = process.env['GESETZ_DB'];
    const override = nodePath.join(root, 'elsewhere', 'cache.db');
    process.env['GESETZ_DB'] = override;
    try {
      expect(resolveStorage(root, false)).toEqual({ kind: 'sqlite', path: override });
      expect(nodeFs.existsSync(nodePath.join(root, 'elsewhere'))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env['GESETZ_DB'];
      else process.env['GESETZ_DB'] = previous;
    }
  });
});

describe('describeStorage', () => {
  it('names the database and the runtime when the cache is on', () => {
    expect(describeStorage({ kind: 'sqlite', path: '/proj/.gesetz/cache.db' }, 'bun')).toBe(
      'cache: /proj/.gesetz/cache.db (runtime: bun)',
    );
  });

  it('says the cache is off when --full bypassed it', () => {
    const line = describeStorage({ kind: 'memory' }, 'node');
    expect(line).toContain('cache: off (--full)');
    expect(line).toContain('every file will be re-checked');
  });

  it('reports the runtime it is given', () => {
    expect(describeStorage({ kind: 'memory' }, 'bun')).toContain('(runtime: bun)');
  });
});

describe('RUNTIME', () => {
  it('names the runtime this process is actually on', () => {
    const expected = typeof (globalThis as { Bun?: unknown }).Bun === 'undefined' ? 'node' : 'bun';
    expect(RUNTIME).toBe(expected);
  });
});

import { describe, it, expect } from 'vitest';
import { toNetworkStorage } from '../../src/engine/runner';

describe('toNetworkStorage', () => {
  it('maps the file-backed kind to libsql with a file url', () => {
    // Regression: gesetz's `{ kind: 'sqlite', path }` was cast straight to
    // netzwerk's config, which only accepts 'memory' or 'libsql'. The unknown
    // kind fell through to netzwerk's default — a database in the user's home
    // directory, shared across every project, instead of the project-local
    // `.gesetz/cache.db`. Stale entries then read as current results.
    expect(toNetworkStorage({ kind: 'sqlite', path: '/tmp/x/.gesetz/cache.db' })).toEqual({
      kind: 'libsql',
      url: 'file:/tmp/x/.gesetz/cache.db',
    });
  });

  it('passes memory through', () => {
    expect(toNetworkStorage({ kind: 'memory' })).toEqual({ kind: 'memory' });
  });

  it('treats an omitted kind as memory', () => {
    expect(toNetworkStorage({})).toEqual({ kind: 'memory' });
  });

  it('never produces a config netzwerk would reject', () => {
    // The set of kinds netzwerk accepts, asserted rather than assumed.
    const allowed = new Set(['memory', 'libsql']);
    for (const storage of [
      { kind: 'memory' } as const,
      {} as const,
      { kind: 'sqlite', path: '/a/b.db' } as const,
    ]) {
      const mapped = toNetworkStorage(storage);
      expect(allowed.has(mapped.kind as string), `${JSON.stringify(mapped)} must be accepted`).toBe(
        true,
      );
    }
  });

  it('keeps the project path, so two projects do not share a cache', () => {
    const a = toNetworkStorage({ kind: 'sqlite', path: '/proj/a/.gesetz/cache.db' });
    const b = toNetworkStorage({ kind: 'sqlite', path: '/proj/b/.gesetz/cache.db' });
    expect(a).not.toEqual(b);
  });
});

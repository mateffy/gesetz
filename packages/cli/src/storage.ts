/**
 * Where a run caches its results.
 *
 * Kept out of `main.ts` so the command file stays about wiring: this is a
 * precedence list, three notices, and the driver probe.
 */
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import {
  defaultCachePath,
  getCacheDriver,
  isNodeSqliteAvailable,
  sqliteUnavailableMessage,
} from '@gesetz/core';

// ─── Storage resolution ─────────────────────────────────────────────────────

/** The JavaScript runtime this process is on, for the cache banner. */
export const RUNTIME = typeof (globalThis as { Bun?: unknown }).Bun === 'undefined' ? 'node' : 'bun';

/** Guards the one-time notices so watch mode does not repeat them. */
let storageNoticeShown = false;

export function noticeOnce(message: string): void {
  if (storageNoticeShown) return;
  storageNoticeShown = true;
  process.stderr.write(`(cache) ${message}\n`);
}

/** Creates `dir` when needed, and reports whether it is writable. */
export function ensureWritableDir(dir: string): boolean {
  try {
    nodeFs.mkdirSync(dir, { recursive: true });
    nodeFs.accessSync(dir, nodeFs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves where this run caches its results.
 *
 * Precedence (highest first):
 *   1. `--full` or `GESETZ_DB=off`        → nothing is persisted
 *   2. `storage: { kind: 'memory' }` in gesetz.config.ts → nothing is persisted
 *   3. `GESETZ_DB=<path>`                 → that path
 *   4. `storage: { kind: 'sqlite', path }` in gesetz.config.ts → that path
 *   5. otherwise                          → the shared cache (`~/.cache/gesetz/cache.db`)
 *   6. shared location unusable           → `<root>/.gesetz/cache.db`
 *
 * The shared cache keeps every project's entries in one file, namespaced by
 * project root, so there is nothing to gitignore and one place to clear. Nothing
 * is shared *between* projects: entries are keyed by repo-relative path and some
 * checks read other files, so cross-project reuse would be wrong.
 *
 * Persistence needs a SQLite driver: the built-in `node:sqlite` module, or one
 * registered by an optional compat package imported from `gesetz.config.ts`.
 * Without either, the run continues in memory and explains how to enable it.
 */
export const resolveStorage = async (
  root: string,
  full: boolean,
  configured: import('@gesetz/core').GesetzStorageConfig | undefined,
): Promise<import('@gesetz/core').GesetzStorageConfig> => {
  if (full) return { kind: 'memory' };
  const override = process.env['GESETZ_DB'];
  if (override === 'off') return { kind: 'memory' };
  if (configured?.kind === 'memory') return { kind: 'memory' };

  if (!(await isNodeSqliteAvailable()) && getCacheDriver('sqlite') === undefined) {
    noticeOnce(sqliteUnavailableMessage());
    return { kind: 'memory' };
  }

  // 1. An explicit path — from the environment or the config — wins outright.
  const explicit = override ?? (configured?.kind === 'sqlite' ? configured.path : undefined);
  if (explicit !== undefined) {
    if (ensureWritableDir(nodePath.dirname(explicit))) return { kind: 'sqlite', path: explicit };
    noticeOnce(`cannot write to ${explicit} — running without a persistent cache.`);
    return { kind: 'memory' };
  }

  // 2. The shared, cross-project cache.
  const shared = defaultCachePath();
  if (ensureWritableDir(nodePath.dirname(shared))) return { kind: 'sqlite', path: shared };

  // 3. Project-local fallback when the shared location is unusable
  //    (read-only HOME, containers, restricted CI runners).
  const local = nodePath.join(root, '.gesetz', 'cache.db');
  if (ensureWritableDir(nodePath.dirname(local))) return { kind: 'sqlite', path: local };

  noticeOnce(`cannot write a cache file — running without a persistent cache.`);
  return { kind: 'memory' };
};

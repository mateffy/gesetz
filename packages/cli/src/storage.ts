/**
 * Where the violation cache lives, and how the run describes it.
 *
 * The cache used to be disabled under Bun on the grounds that better-sqlite3 is
 * unsupported there. netzwerk does not use better-sqlite3 — it uses
 * @libsql/client, which works under Bun. Disabling it made every run from a Bun
 * process a full cold run, and agents invoke `bun node_modules/.bin/gesetz` in
 * the projects where gesetz is installed.
 */
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import type { GesetzStorageConfig } from '@gesetz/core';

/** The JavaScript runtime this process is running on, for the cache banner. */
export const RUNTIME =
  typeof (globalThis as { Bun?: unknown }).Bun === 'undefined' ? 'node' : 'bun';

/**
 * Default cache location; GESETZ_DB overrides. `--full` bypasses the cache.
 */
export const resolveStorage = (root: string, full: boolean): GesetzStorageConfig => {
  if (full) return { kind: 'memory' };
  const dbPath = process.env['GESETZ_DB'] ?? nodePath.join(root, '.gesetz', 'cache.db');
  nodeFs.mkdirSync(nodePath.dirname(dbPath), { recursive: true });
  return { kind: 'sqlite', path: dbPath };
};

/**
 * One line naming the cache in use and the runtime that resolved it.
 *
 * A cache-less run looks exactly like a fast machine, which is how the cache
 * stayed off under Bun for so long. Naming it makes that visible, and naming the
 * runtime makes a surprise ("I thought this was node") visible too.
 */
export const describeStorage = (storage: GesetzStorageConfig, runtime: string): string =>
  storage.kind === 'sqlite'
    ? `cache: ${storage.path} (runtime: ${runtime})`
    : `cache: off (--full) — every file will be re-checked (runtime: ${runtime})`;

import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';

/** True when running under Bun (better-sqlite3 is unsupported there). */
const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';

export type StorageConfig =
  | { readonly kind?: 'memory' | undefined }
  | { readonly kind: 'sqlite'; readonly path: string; readonly dimensions?: number | undefined };

/**
 * Default cache location; GESETZ_DB overrides. `--full` bypasses the cache.
 * Under Bun the cache is disabled: better-sqlite3 is not supported there
 * (a bun:sqlite storage backend for netzwerk is a possible follow-up).
 */
export const resolveStorage = (root: string, full: boolean): StorageConfig => {
  if (full || isBun) return { kind: 'memory' };
  const dbPath = process.env.GESETZ_DB ?? nodePath.join(root, '.gesetz', 'cache.db');
  nodeFs.mkdirSync(nodePath.dirname(dbPath), { recursive: true });
  return { kind: 'sqlite', path: dbPath };
};

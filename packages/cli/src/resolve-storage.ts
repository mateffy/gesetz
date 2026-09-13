import * as nodeFs from 'node:fs';
import * as nodeOs from 'node:os';
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

  // netzwerk's storageFor() ignores { kind: 'sqlite', path } and always
  // resolves its own path via resolveNetzwerkDbPath() → ~/.fabrik/netzwerk.db.
  // Until that is fixed upstream, ensure the directory exists so SQLite
  // can open the database.  TODO: remove once netzwerk honours sqlite.path.
  const netzwerkDir = nodePath.join(nodeOs.homedir(), '.fabrik');
  try {
    nodeFs.mkdirSync(netzwerkDir, { recursive: true });
  } catch (err) {
    process.stderr.write(
      `warning: unable to create ${netzwerkDir} — falling back to memory storage: ${String(err)}\n`,
    );
    return { kind: 'memory' };
  }

  return { kind: 'sqlite', path: dbPath };
};

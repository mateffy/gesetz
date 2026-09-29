import { getCacheDriver } from './drivers';
import type { CacheEntry, CacheStore } from './types';

/**
 * Minimal structural view of a better-sqlite3 / `node:sqlite` style database.
 * Declared locally so this module does not depend on the Node type definitions
 * exposing the experimental `node:sqlite` module (its typings lag across Node
 * versions). Both drivers satisfy this interface, which is what lets the
 * optional compat package reuse this whole file's logic.
 */
export interface SqliteLikeStatement {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

export interface SqliteLikeDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): SqliteLikeStatement;
  close(): unknown;
}

interface SqliteModule {
  DatabaseSync: new (path: string) => SqliteLikeDatabase;
}

interface Row {
  readonly path: string;
  readonly hash: string;
  readonly stamp: string | null;
  readonly fingerprint: string | null;
  readonly value: string;
}

/** Which driver backs `{ kind: 'sqlite' }`. */
export type SqliteDriver = 'auto' | 'node' | 'compat';

/**
 * A shared cache file holds every project's entries, so each project writes
 * under its own namespace (its absolute project root). Dedicated per-project
 * files only ever hold one namespace, so the default is fine there.
 */
export interface SqliteStoreNamespaceOptions {
  /** Namespace for all entries. Defaults to the empty (unscoped) namespace. */
  readonly namespace?: string | undefined;
  /**
   * Entries older than this are swept when the store opens, so a shared cache
   * cannot grow without bound. Default: 30 days. `0` disables the sweep.
   */
  readonly ttlMs?: number | undefined;
}

export interface SqliteStoreOptions extends SqliteStoreNamespaceOptions {
  readonly driver?: SqliteDriver | undefined;
}

/** Thrown when no usable SQLite driver is available. */
export class SqliteUnavailableError extends Error {
  constructor(message: string = sqliteUnavailableMessage()) {
    super(message);
    this.name = 'SqliteUnavailableError';
  }
}

/** The package a consumer can install to get SQLite caching on older Node. */
export const SQLITE_COMPAT_PACKAGE = '@gesetz/sqlite-compat';

/** Bump when the table layout changes. A mismatch discards the cache. */
const SCHEMA_VERSION = 3;

/** Default retention for cache entries. */
export const DEFAULT_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS cache_entries (
    workdir     TEXT NOT NULL,
    scope       TEXT NOT NULL,
    path        TEXT NOT NULL,
    hash        TEXT NOT NULL,
    stamp       TEXT,
    fingerprint TEXT,
    value       TEXT NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (workdir, scope, path)
  );
  CREATE INDEX IF NOT EXISTS cache_entries_scope ON cache_entries (workdir, scope);
  CREATE INDEX IF NOT EXISTS cache_entries_age ON cache_entries (updated_at);
`;

/** Actionable message shown whenever SQLite caching cannot be used. */
export function sqliteUnavailableMessage(): string {
  return [
    'SQLite caching is unavailable, so this run will not persist a cache.',
    'The built-in driver needs Node >= 23.4 (or Node >= 22.5 with --experimental-sqlite),',
    'or Bun, whose `bun:sqlite` module is used automatically.',
    'To enable it on this runtime, install the optional compatibility package',
    `  pnpm add -D ${SQLITE_COMPAT_PACKAGE}`,
    `and import '${SQLITE_COMPAT_PACKAGE}' from gesetz.config.ts.`,
  ].join('\n');
}

let nodeSqliteProbe: Promise<SqliteModule | null> | undefined;

/**
 * The SQLite module for this runtime.
 *
 * `node:sqlite` where it exists, and `bun:sqlite` under Bun, which has no
 * `node:sqlite` but ships a compatible `Database`/`prepare`/`all`/`run` API. The
 * difference matters: agents invoke `bun node_modules/.bin/gesetz` in the projects
 * where gesetz is installed, and without this every one of those runs would report
 * "SQLite caching is unavailable" and re-check the whole project — the same
 * silent-cache-off failure this engine was adopted to fix.
 */
function loadNodeSqlite(): Promise<SqliteModule | null> {
  nodeSqliteProbe ??= (async () => {
    // Not every runtime has `node:sqlite`; the fallbacks below are the point, so a
    // failed import is expected rather than exceptional.
    const nodeSqlite = await import('node:sqlite').catch(() => null);
    if (nodeSqlite !== null) return nodeSqlite as unknown as SqliteModule;
    if (typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined') {
      try {
        // No static specifier: `bun:sqlite` is unknown to TypeScript here, and a
        // literal import would also be resolved by Node bundlers at build time.
        const specifier = 'bun:sqlite';
        const bunSqlite = (await import(specifier)) as unknown as {
          Database: SqliteModule['DatabaseSync'];
        };
        return { DatabaseSync: bunSqlite.Database } as unknown as SqliteModule;
      } catch {
        return null;
      }
    }
    return null;
  })();
  return nodeSqliteProbe;
}

/**
 * True when a built-in SQLite module can be imported on this runtime
 * (`node:sqlite`, or `bun:sqlite` under Bun).
 */
export async function isNodeSqliteAvailable(): Promise<boolean> {
  return (await loadNodeSqlite()) !== null;
}

/**
 * A row as an entry, or `undefined` when the row cannot be one.
 *
 * A cache is an optimization: a row that cannot be interpreted has to read as a
 * miss so the value is recomputed. A crash, or worse a half-parsed entry, would
 * make the cache a correctness hazard instead.
 */
function toEntry<Value>(row: Row): CacheEntry<Value> | undefined {
  if (typeof row.hash !== 'string' || row.hash === '') return undefined;
  let value: Value;
  try {
    value = JSON.parse(row.value) as Value;
  } catch {
    // ponytail: corrupt row → miss → recomputed. If this ever bites, write the
    // raw text to stderr instead of dropping it silently.
    return undefined;
  }
  return {
    hash: row.hash,
    value,
    ...(row.stamp === null || row.stamp === undefined ? {} : { stamp: row.stamp as string }),
    ...(row.fingerprint !== null ? { meta: { fingerprint: row.fingerprint } } : {}),
  };
}

/**
 * Creates (or migrates) the table. A `user_version` mismatch means the layout
 * changed, and since this is only ever a cache the old contents are dropped
 * rather than migrated.
 */
function prepareSchema(db: SqliteLikeDatabase): void {
  db.exec('PRAGMA journal_mode = WAL');
  // A shared cache file can have several gesetz processes writing to it; wait
  // for the lock instead of failing with SQLITE_BUSY.
  db.exec('PRAGMA busy_timeout = 5000');

  const row = db.prepare('PRAGMA user_version').get() as { user_version?: unknown } | undefined;
  const version = Number(row?.user_version ?? 0);
  if (version === SCHEMA_VERSION) {
    db.exec(SCHEMA);
    return;
  }
  db.exec('DROP TABLE IF EXISTS cache_entries');
  db.exec(SCHEMA);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

function sweepExpired(db: SqliteLikeDatabase, ttlMs: number): void {
  if (ttlMs <= 0) return;
  db.prepare('DELETE FROM cache_entries WHERE updated_at < ?').run(Date.now() - ttlMs);
}

/**
 * Builds a `CacheStore` over any SQLite database exposing the
 * better-sqlite3/`node:sqlite` shape. Shared by the built-in driver and the
 * optional `@gesetz/sqlite-compat` package.
 */
export function createSqliteStoreFromDatabase(
  db: SqliteLikeDatabase,
  options: SqliteStoreNamespaceOptions = {},
): CacheStore {
  const namespace = options.namespace ?? '';
  const ttlMs = options.ttlMs ?? DEFAULT_CACHE_TTL_MS;

  prepareSchema(db);
  sweepExpired(db, ttlMs);

  const selectOne = db.prepare(
    'SELECT path, hash, stamp, fingerprint, value FROM cache_entries WHERE workdir = ? AND scope = ? AND path = ?',
  );
  const selectScope = db.prepare(
    'SELECT path, hash, stamp, fingerprint, value FROM cache_entries WHERE workdir = ? AND scope = ?',
  );
  const upsert = db.prepare(
    `INSERT INTO cache_entries (workdir, scope, path, hash, stamp, fingerprint, value, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (workdir, scope, path) DO UPDATE SET
       hash = excluded.hash,
       stamp = excluded.stamp,
       fingerprint = excluded.fingerprint,
       value = excluded.value,
       updated_at = excluded.updated_at`,
  );
  const remove = db.prepare(
    'DELETE FROM cache_entries WHERE workdir = ? AND scope = ? AND path = ?',
  );

  return {
    async get<Value>(scope: string, entryPath: string): Promise<CacheEntry<Value> | undefined> {
      // A missing row is `undefined` under node:sqlite and `null` under bun:sqlite.
      // Both mean "not cached", and a miss must be a miss, not a crash.
      const row = selectOne.get(namespace, scope, entryPath) as Row | null | undefined;
      return row === null || row === undefined ? undefined : toEntry<Value>(row);
    },

    async put<Value>(scope: string, entryPath: string, entry: CacheEntry<Value>): Promise<void> {
      upsert.run(
        namespace,
        scope,
        entryPath,
        entry.hash,
        entry.stamp ?? null,
        entry.meta?.['fingerprint'] ?? null,
        JSON.stringify(entry.value),
        Date.now(),
      );
    },

    async delete(scope: string, entryPath: string): Promise<void> {
      remove.run(namespace, scope, entryPath);
    },

    async entries<Value>(scope: string): Promise<ReadonlyMap<string, CacheEntry<Value>>> {
      const rows = selectScope.all(namespace, scope) as Row[];
      const found = new Map<string, CacheEntry<Value>>();
      for (const row of rows) {
        const entry = toEntry<Value>(row);
        if (entry !== undefined) found.set(row.path, entry);
      }
      return found;
    },

    async prune(scope: string, keep: ReadonlySet<string>): Promise<readonly string[]> {
      const rows = selectScope.all(namespace, scope) as Row[];
      const removed: string[] = [];
      for (const row of rows) {
        if (!keep.has(row.path)) {
          remove.run(namespace, scope, row.path);
          removed.push(row.path);
        }
      }
      return removed;
    },

    async close(): Promise<void> {
      db.close();
    },
  };
}

/**
 * SQLite-backed store using the built-in `node:sqlite` module.
 *
 * `driver` selects the backend:
 * - `node`   — the built-in module only; fails if unavailable.
 * - `compat` — a driver registered via `registerCacheDriver` (e.g. from
 *              `@gesetz/sqlite-compat`); fails if none is registered.
 * - `auto`   — the built-in module when available, otherwise a registered
 *              driver; fails with an actionable message when neither works.
 *
 * Requires Node >= 23.4 (or >= 22.5 with `--experimental-sqlite`).
 */
export async function createSqliteStore(
  path: string,
  options: SqliteStoreOptions = {},
): Promise<CacheStore> {
  const driver = options.driver ?? 'auto';

  if (driver !== 'compat') {
    const sqlite = await loadNodeSqlite();
    if (sqlite !== null) {
      return createSqliteStoreFromDatabase(new sqlite.DatabaseSync(path), options);
    }
    if (driver === 'node') throw new SqliteUnavailableError();
  }

  const fallback = getCacheDriver('sqlite');
  if (fallback !== undefined) return fallback(path, options);

  throw new SqliteUnavailableError();
}

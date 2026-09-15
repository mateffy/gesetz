/**
 * `@gesetz/sqlite-compat` — optional SQLite cache driver for runtimes without a
 * usable `node:sqlite` module (Node < 23.4, or Bun).
 *
 * ## Why this is a separate package
 *
 * `@gesetz/core` must stay dependency-light, so it never depends on a native
 * SQLite binding. Instead it exposes a driver registry, and this package
 * registers a `better-sqlite3`-backed implementation under the `sqlite` kind.
 *
 * ## Usage
 *
 * Install `better-sqlite3` and this package, then import it once from
 * `gesetz.config.ts` — the registration is the entire opt-in:
 *
 * ```ts
 * // gesetz.config.ts
 * import '@gesetz/sqlite-compat';
 * import { defineConfig } from 'gesetz';
 *
 * export default defineConfig({
 *   storage: { kind: 'sqlite', path: '.gesetz/cache.db' },
 *   rules: [/* … *\/],
 * });
 * ```
 *
 * `gesetz check` will then use `better-sqlite3` automatically when
 * `node:sqlite` is unavailable. To force it even where `node:sqlite` exists,
 * set `storage: { kind: 'sqlite', path, driver: 'compat' }`.
 *
 * If `better-sqlite3` cannot be resolved, importing this module is a no-op and
 * gesetz falls back to the JSON cache.
 */
import { createRequire } from 'node:module';
import {
  createSqliteStoreFromDatabase,
  registerCacheDriver,
  type CacheStore,
  type SqliteLikeDatabase,
  type SqliteStoreNamespaceOptions,
} from '@gesetz/core';

/**
 * The subset of the `better-sqlite3` constructor we use. Declared structurally
 * so this package typechecks without `@types/better-sqlite3` installed.
 */
export interface BetterSqliteConstructor {
  new (path: string): SqliteLikeDatabase;
}

/** Loads the raw `better-sqlite3` module export. Injectable for tests. */
export type BetterSqliteLoader = () => unknown | Promise<unknown>;

export interface CreateBetterSqliteStoreOptions extends SqliteStoreNamespaceOptions {
  /** Use an already-resolved constructor instead of loading `better-sqlite3`. */
  readonly ctor?: BetterSqliteConstructor | undefined;
  /** Override the module loader. Intended for tests. */
  readonly load?: BetterSqliteLoader | undefined;
}

const SQLITE_MODULE = 'better-sqlite3';

/** Accepts either `module.exports = Ctor` or `{ default: Ctor }`. */
function resolveConstructor(module: unknown): BetterSqliteConstructor | null {
  if (typeof module === 'function') return module as BetterSqliteConstructor;
  if (module !== null && typeof module === 'object') {
    const candidate = (module as { default?: unknown }).default;
    if (typeof candidate === 'function') return candidate as BetterSqliteConstructor;
  }
  return null;
}

let cachedConstructor: BetterSqliteConstructor | null | undefined;

function loadConstructor(): BetterSqliteConstructor | null {
  cachedConstructor ??= (() => {
    try {
      const require = createRequire(import.meta.url);
      return resolveConstructor(require(SQLITE_MODULE));
    } catch {
      return null;
    }
  })();
  return cachedConstructor;
}

/**
 * Creates a cache store backed by `better-sqlite3`.
 *
 * Throws with an actionable message when `better-sqlite3` is not installed.
 */
export async function createBetterSqliteStore(
  path: string,
  options: CreateBetterSqliteStoreOptions = {},
): Promise<CacheStore> {
  const ctor =
    options.ctor ?? (options.load !== undefined
      ? resolveConstructor(await options.load())
      : loadConstructor());

  if (ctor === null) {
    throw new Error(
      `gesetz: ${SQLITE_MODULE} is not installed, so @gesetz/sqlite-compat cannot back the cache. ` +
        `Install it with: pnpm add -D ${SQLITE_MODULE}`,
    );
  }

  return createSqliteStoreFromDatabase(new ctor(path), {
    namespace: options.namespace,
    ttlMs: options.ttlMs,
  });
}

/**
 * Registers the `better-sqlite3` driver with `@gesetz/core`.
 * Returns false (and registers nothing) when `better-sqlite3` is unavailable.
 */
export function registerBetterSqliteDriver(
  load: BetterSqliteLoader = () => loadConstructor(),
): boolean {
  const resolved = resolveConstructor(load());
  if (resolved === null) return false;
  registerCacheDriver('sqlite', (path, options) =>
    createBetterSqliteStore(path, { ctor: resolved, ...(options ?? {}) }),
  );
  return true;
}

// Auto-register on import so `import '@gesetz/sqlite-compat'` is the whole
// opt-in. A no-op when better-sqlite3 is not installed.
registerBetterSqliteDriver();

import type { CacheStore } from './types';
import type { SqliteStoreNamespaceOptions } from './store-sqlite';

/**
 * Factory for an alternative backing store for a storage kind.
 *
 * Registered by optional compatibility packages so the core library never has
 * to depend on a native driver. `@gesetz/sqlite-compat` registers a
 * `better-sqlite3` implementation under the `sqlite` kind.
 *
 * The namespace/ttl options are passed through so a compat driver can honour
 * the same shared-cache scoping as the built-in one.
 */
export type CacheDriverFactory = (
  path: string,
  options?: SqliteStoreNamespaceOptions,
) => Promise<CacheStore>;

/** Storage kinds a driver can back. Only `sqlite` has a fallback today. */
export type CacheDriverKind = 'sqlite';

const drivers = new Map<CacheDriverKind, CacheDriverFactory>();

/** Registers (or replaces) the fallback driver for a storage kind. */
export function registerCacheDriver(kind: CacheDriverKind, factory: CacheDriverFactory): void {
  drivers.set(kind, factory);
}

/** Returns the registered fallback driver, if any. */
export function getCacheDriver(kind: CacheDriverKind): CacheDriverFactory | undefined {
  return drivers.get(kind);
}

/** Removes a registered driver. Intended for tests and for explicit opt-out. */
export function unregisterCacheDriver(kind: CacheDriverKind): void {
  drivers.delete(kind);
}

import { createMemoryStore, createSqliteStore } from '../cache';
import type { CacheStore } from '../cache';
import type { GesetzStorageConfig } from './config';

/**
 * Instantiates the store named by a `GesetzStorageConfig`.
 *
 * `undefined` means "not specified" and yields an in-memory store, so
 * programmatic `runAll` callers never write to disk by accident. Resolving the
 * default persistent location is the CLI's job (see `cache-path.ts`).
 *
 * `namespace` scopes entries within a shared cache file — the default cache is
 * shared across projects, and entries are keyed by repo-relative path, so each
 * project root gets its own namespace.
 */
export async function createConfiguredStore(
  storage: GesetzStorageConfig | undefined,
  namespace: string,
): Promise<CacheStore> {
  if (storage?.kind === 'sqlite') return createSqliteStore(storage.path, { namespace });
  return createMemoryStore();
}

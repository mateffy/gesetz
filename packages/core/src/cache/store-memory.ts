import type { CacheEntry, CacheStore } from './types';

/** In-memory store. Used for `{ kind: 'memory' }`, tests, and `--full` runs. */
export function createMemoryStore(): CacheStore {
  const data = new Map<string, Map<string, CacheEntry>>();

  const scopeOf = (scope: string): Map<string, CacheEntry> => data.get(scope) ?? new Map();

  return {
    async get<Value>(scope: string, path: string): Promise<CacheEntry<Value> | undefined> {
      return scopeOf(scope).get(path) as CacheEntry<Value> | undefined;
    },

    async put<Value>(scope: string, path: string, entry: CacheEntry<Value>): Promise<void> {
      const bucket = data.get(scope) ?? new Map<string, CacheEntry>();
      bucket.set(path, entry as CacheEntry);
      data.set(scope, bucket);
    },

    async entries<Value>(scope: string): Promise<ReadonlyMap<string, CacheEntry<Value>>> {
      return new Map(scopeOf(scope)) as ReadonlyMap<string, CacheEntry<Value>>;
    },

    async delete(scope: string, path: string): Promise<void> {
      data.get(scope)?.delete(path);
    },

    async prune(scope: string, keep: ReadonlySet<string>): Promise<readonly string[]> {
      const bucket = data.get(scope);
      if (bucket === undefined) return [];
      const removed: string[] = [];
      for (const path of [...bucket.keys()]) {
        if (!keep.has(path)) {
          bucket.delete(path);
          removed.push(path);
        }
      }
      return removed;
    },

    async close(): Promise<void> {
      data.clear();
    },
  };
}

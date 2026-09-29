/**
 * Storage port for the incremental cache.
 *
 * Deliberately tiny: get/put/entries/prune/close. The kernel depends on
 * nothing else, and every concept here is gesetz-agnostic so this directory
 * can be lifted into its own package unchanged (see README.md).
 */

/** A file the cache tracks. Paths are repo-relative with posix separators. */
export interface FileRef {
  readonly path: string;
  readonly absolutePath: string;
}

/** One cached computation for one (scope, path) pair. */
export interface CacheEntry<Value = unknown> {
  /** Content hash of the file at the time `value` was computed. */
  readonly hash: string;
  /**
   * `mtimeMs:size` for the file when `value` was computed.
   *
   * This is what lets a run reuse a result without reading the file: if the stamp
   * is unchanged the content almost certainly is too, and the cache never has to
   * touch 700 MB to find out. See `sync` for the ceiling that accepts.
   */
  readonly stamp?: string | undefined;
  /** The cached payload. Must be JSON-serialisable. */
  readonly value: Value;
  /**
   * Extra validity material. The kernel stores `fingerprint` here: when it
   * differs from the incoming fingerprint, every entry in the scope is
   * recomputed even if every content hash is unchanged. This is how editing a
   * rule invalidates its cached results.
   */
  readonly meta?: Readonly<Record<string, string>> | undefined;
}

/** Storage backend for the incremental cache. */
export interface CacheStore {
  get<Value = unknown>(scope: string, path: string): Promise<CacheEntry<Value> | undefined>;
  put<Value = unknown>(scope: string, path: string, entry: CacheEntry<Value>): Promise<void>;
  /** Removes one entry. Missing entries are ignored. */
  delete(scope: string, path: string): Promise<void>;
  /** Every entry in `scope`, keyed by path. */
  entries<Value = unknown>(scope: string): Promise<ReadonlyMap<string, CacheEntry<Value>>>;
  /** Deletes entries in `scope` whose path is not in `keep`. Returns removed paths. */
  prune(scope: string, keep: ReadonlySet<string>): Promise<readonly string[]>;
  close(): Promise<void>;
}

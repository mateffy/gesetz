import { readFile } from 'node:fs/promises';
import { hashBytes } from './hash';
import type { CacheEntry, CacheStore, FileRef } from './types';

/** The bytes + hash handed to `compute` for a file that needs (re)computing. */
export interface FileSource {
  readonly content: string;
  readonly hash: string;
}

export interface SyncProgress {
  readonly done: number;
  readonly total: number;
  readonly current: string;
}

export interface SyncOptions<Value> {
  /** Cache namespace. Use one scope per rule, parser, or extension. */
  readonly scope: string;
  readonly store: CacheStore;
  /** The files to consider. Discovery is the caller's job. */
  readonly files: readonly FileRef[];
  /** Recompute everything, ignoring stored entries and the fingerprint. */
  readonly force?: boolean | undefined;
  /**
   * Validity material for the whole scope. When it differs from the stored
   * fingerprint, every entry in the scope is recomputed. Typical value: the
   * combined fingerprint of the producers whose output is cached here.
   */
  readonly fingerprint?: string | undefined;
  /** Reads a file into `{ content, hash }`. Default: read bytes, sha1, utf8. */
  readonly read?: ((file: FileRef) => Promise<FileSource>) | undefined;
  /** Computes the cached value for an added or changed file. */
  readonly compute: (file: FileRef, source: FileSource) => Promise<ComputeResult<Value>>;
  readonly onProgress?: ((event: SyncProgress) => void) | undefined;
}

/**
 * Returned by `compute` to mean "I did not compute a value for this file; leave
 * whatever is stored for it alone".
 *
 * `sync` prunes a scope to the files it is given, so a caller that narrows the list
 * — a `--files` run — would otherwise delete the entries of every file it skipped,
 * and store an empty result for the ones it looked at. Neither is acceptable: a
 * skipped file's entry is still valid (its content did not change), and an empty
 * result is indistinguishable from a clean file.
 */
export const KEEP_STORED: unique symbol = Symbol('gesetz.cache.keep-stored');

export type ComputeResult<Value> = Value | typeof KEEP_STORED;

export interface SyncResult<Value> {
  readonly values: ReadonlyMap<string, Value>;
  readonly hashes: ReadonlyMap<string, string>;
  readonly added: readonly string[];
  readonly changed: readonly string[];
  readonly removed: readonly string[];
  readonly reused: readonly string[];
  readonly durationMs: number;
}

const READ_CONCURRENCY = 8;

async function defaultRead(file: FileRef): Promise<FileSource> {
  const bytes = await readFile(file.absolutePath);
  return { content: bytes.toString('utf8'), hash: hashBytes(bytes) };
}

/** Reads a file, returning null when it vanished since discovery. */
/**
 * Reads a file, returning null when there is nothing to read.
 *
 * Two structural cases, both of which discovery can hand us because it lists what
 * git has rather than what is on disk:
 *
 * - `ENOENT` — the file is in the index but deleted (a colleague's in-flight
 *   state, or a checkout mid-edit).
 * - `EISDIR` — the path is a symlink to a directory. Laravel's `public/storage`
 *   is the common one, and git stores the symlink as a file.
 *
 * Anything else is a real error and is raised: silently skipping an unreadable
 * file would look exactly like checking it and finding nothing.
 */
async function readSafely(
  read: (file: FileRef) => Promise<FileSource>,
  file: FileRef,
): Promise<FileSource | null> {
  try {
    return await read(file);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'ENOENT' || code === 'EISDIR') return null;
    throw error;
  }
}

/** Runs `fn` over `items` with a bounded number of concurrent calls. */
async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Math.min(limit, items.length);
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index] as T);
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

/**
 * Hashes `files`, diffs them against the stored entries for `scope`, recomputes
 * added/changed files via `compute`, prunes entries for vanished files, and
 * returns the full path -> value map.
 *
 * Content hash is the ONLY reuse signal — never mtimes. `fingerprint` and
 * `force` are the two explicit escape hatches for invalidating the scope.
 */
export async function sync<Value>(options: SyncOptions<Value>): Promise<SyncResult<Value>> {
  const startedAt = Date.now();
  const { scope, store, files, compute } = options;
  const read = options.read ?? defaultRead;

  const stored = await store.entries<Value>(scope);
  const fingerprintChanged =
    options.fingerprint !== undefined &&
    stored.size > 0 &&
    [...stored.values()].some((entry) => entry.meta?.['fingerprint'] !== options.fingerprint);

  // Hash phase. A file that vanished between discovery and this read is skipped
  // here and pruned below.
  const sources = await mapConcurrent(files, READ_CONCURRENCY, (file) =>
    readSafely(read, file),
  );

  const added: string[] = [];
  const changed: string[] = [];
  const reused: string[] = [];
  const values = new Map<string, Value>();
  const hashes = new Map<string, string>();
  const toCompute: number[] = [];
  const keep = new Set<string>();

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index] as FileRef;
    const source = sources[index] as FileSource | null;
    if (source === null) continue;
    keep.add(file.path);
    hashes.set(file.path, source.hash);

    const previous = stored.get(file.path);
    if (
      previous === undefined ||
      previous.hash !== source.hash ||
      options.force === true ||
      fingerprintChanged
    ) {
      if (previous === undefined) added.push(file.path);
      else changed.push(file.path);
      toCompute.push(index);
    } else {
      reused.push(file.path);
      values.set(file.path, previous.value);
    }
  }

  // Compute phase.
  const total = toCompute.length;
  let done = 0;
  for (const index of toCompute) {
    const file = files[index] as FileRef;
    const source = sources[index] as FileSource;
    const value = await compute(file, source);
    if (value === KEEP_STORED) {
      // Nothing computed for this file this time. Its stored entry stands — it is
      // still valid, because the content hash has not moved — and `keep` already
      // holds the path, so pruning leaves it alone too.
      const previous = stored.get(file.path);
      if (previous !== undefined) values.set(file.path, previous.value);
      continue;
    }
    values.set(file.path, value);
    const entry: CacheEntry<Value> = {
      hash: source.hash,
      value,
      ...(options.fingerprint !== undefined
        ? { meta: { fingerprint: options.fingerprint } }
        : {}),
    };
    await store.put(scope, file.path, entry);
    done += 1;
    options.onProgress?.({ done, total, current: file.path });
  }

  // Prune phase. `keep` holds only files that were successfully read.
  const removed = await store.prune(scope, keep);

  return { values, hashes, added, changed, removed, reused, durationMs: Date.now() - startedAt };
}

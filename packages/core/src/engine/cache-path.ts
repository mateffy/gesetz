import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';

/**
 * Directory for gesetz's shared, cross-project cache.
 *
 * The cache is content-hash keyed and must be scoped per project (entries are
 * keyed by repo-relative path, and per-file checks can depend on other files),
 * so a shared file namespaces every entry by project root rather than sharing
 * results between projects.
 *
 * Uses `$XDG_CACHE_HOME` when set, else `~/.cache` — the conventional location
 * for regenerable data, deliberately outside any repository so nothing needs to
 * be gitignored. Clearing the cache is `rm -rf <this directory>`.
 */
export function defaultCacheDir(): string {
  const xdg = process.env['XDG_CACHE_HOME'];
  const base = xdg !== undefined && xdg !== '' ? xdg : nodePath.join(nodeOs.homedir(), '.cache');
  return nodePath.join(base, 'gesetz');
}

/** Default database file inside {@link defaultCacheDir}. */
export function defaultCachePath(): string {
  return nodePath.join(defaultCacheDir(), 'cache.db');
}

/**
 * What the project tree looks like right now: which files exist, and when each
 * was last written.
 *
 * Two callers need this. A rule's cache key mixes in the file *set*, because a
 * check may consult files other than the one it runs for — `requireTest` looks
 * for a test file beside the source — so an added or deleted file must
 * invalidate answers that depended on it. Concurrent `gesetz check` processes
 * compare the whole tree state, so that a run one of them already performed can
 * answer for the others.
 *
 * Both are one walk plus one `stat` per file. Reading file *contents* is the
 * cost this exists to avoid; contents are hashed per file by the scan.
 */
import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';

/** Directories that never contain project source, skipped by the walk. */
const NEVER_SOURCE = new Set([
  '.git',
  '.gesetz',
  '.next',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules',
]);

/**
 * Sorted repo-relative paths of every file, skipping `NEVER_SOURCE`.
 *
 * Exported so a `--files` request can be turned into the paths it matches
 * without a second, differently-filtered walk.
 */
export function listFiles(rootDir: string): string[] {
  const paths: string[] = [];
  const walk = (dir: string): void => {
    let entries: nodeFs.Dirent[];
    try {
      entries = nodeFs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory: not part of the file set
    }
    for (const entry of entries) {
      if (NEVER_SOURCE.has(entry.name)) continue;
      const absolutePath = nodePath.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolutePath);
      else if (entry.isFile()) paths.push(nodePath.relative(rootDir, absolutePath));
    }
  };
  walk(rootDir);
  paths.sort();
  return paths;
}

function fingerprintPaths(paths: readonly string[]): string {
  return createHash('sha256').update(paths.join('\n')).digest('hex');
}

export interface TreeState {
  /** sha256 over the sorted relative paths. */
  readonly pathsFingerprint: string;
  /** Relative path → `${mtimeNs}:${size}`. */
  readonly statMap: Readonly<Record<string, string>>;
}

/**
 * The file set plus each file's metadata.
 *
 * ponytail: metadata equality is not proof of content equality. A writer that
 * restores mtimes exactly, or writes inside the same nanosecond as the recorded
 * one, is not detected. `--standalone` and `--full` skip reuse entirely.
 */
export function treeStateFor(rootDir: string): TreeState {
  const paths = listFiles(rootDir);
  const statMap: Record<string, string> = {};
  for (const relativePath of paths) {
    try {
      const stats = nodeFs.statSync(nodePath.join(rootDir, relativePath), { bigint: true });
      statMap[relativePath] = `${stats.mtimeNs}:${stats.size}`;
    } catch {
      // Vanished between the walk and the stat, so it is not part of any state.
      // Leaving it out changes the path count, so a comparison against a complete
      // state refuses the reuse rather than accepting a stale one.
      continue;
    }
  }
  return { pathsFingerprint: fingerprintPaths(paths), statMap };
}

/** True when two tree states describe the same files with the same metadata. */
export function treeStatesMatch(a: TreeState, b: TreeState): boolean {
  if (a.pathsFingerprint !== b.pathsFingerprint) return false;
  const aKeys = Object.keys(a.statMap);
  if (aKeys.length !== Object.keys(b.statMap).length) return false;
  for (const key of aKeys) {
    if (a.statMap[key] !== b.statMap[key]) return false;
  }
  return true;
}

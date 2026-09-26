/**
 * Fingerprint of the project's file set.
 *
 * A check may consult files other than the one it is running for — `requireTest`
 * looks for a test file beside the source, `requireSibling` for a sibling. Those
 * answers change when a file is added or removed, but no *existing* file's
 * content changes, so a content-keyed cache would reuse the marker it stored
 * last time and the violation would outlive the file that fixed it.
 *
 * Mixing this fingerprint into a rule's cache key makes a change to the file set
 * reprocess everything, which is the only sound answer for a check that reads
 * the file system.
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
 * Paths only, never contents: cheap, and contents are already hashed per file.
 * The sort makes the result independent of directory order.
 */
export function fileSetFingerprint(rootDir: string): string {
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
  return createHash('sha256').update(paths.join('\n')).digest('hex');
}

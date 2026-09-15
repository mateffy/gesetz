import * as childProcess from 'node:child_process';
import * as nodePath from 'node:path';
import fastGlob from 'fast-glob';
import micromatch from 'micromatch';
import type { FileRef } from '../cache/types';
import type { ResolvedConfig } from './config';

/** Ignored on top of whatever the file source already excludes. */
const ALWAYS_IGNORED = ['**/node_modules/**', '**/.git/**'];

/**
 * Lists every tracked file plus every untracked, non-ignored file, relative to
 * `projectRoot`, by asking git. This honours `.gitignore`, `.git/info/exclude`
 * and `core.excludesFile` with full nested-file semantics.
 *
 * Returns `null` when `projectRoot` is not inside a git repository or when git
 * is unavailable, so the caller can fall back to a plain walk.
 *
 * Note: git lists files that are in the index but deleted from disk. The cache
 * kernel skips files it cannot read, so that is safe.
 */
export function listGitFiles(projectRoot: string): string[] | null {
  try {
    const output = childProcess.execFileSync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'],
      {
        cwd: projectRoot,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    return output.split('\0').filter((path) => path !== '');
  } catch {
    return null;
  }
}

/** Plain recursive walk. Cannot honour `.gitignore` — used only outside a repo. */
async function walkProjectFiles(projectRoot: string): Promise<string[]> {
  return fastGlob('**/*', {
    cwd: projectRoot,
    absolute: false,
    dot: true,
    onlyFiles: true,
    unique: true,
    ignore: ALWAYS_IGNORED,
  });
}

/**
 * Every file in the project that is not ignored, repo-relative and sorted.
 *
 * There is deliberately NO size cap and NO binary sniffing: a naive 64 KB
 * default silently skipped large files, which this must never do.
 */
export async function listProjectFiles(projectRoot: string): Promise<readonly string[]> {
  const listed = listGitFiles(projectRoot);
  const all = listed ?? (await walkProjectFiles(projectRoot));
  return all
    .filter((path) => !micromatch.isMatch(path, ALWAYS_IGNORED, { dot: true }))
    .sort();
}

/**
 * Collects every glob pattern any rule could match, deduplicated.
 *
 * A run-only rule (no `perFile`, no `project`) may scan arbitrary files through
 * `fs.glob`, so it forces the candidate set to the whole project — otherwise its
 * change-detection hash would be constant and it would never re-run.
 */
export function rulePatterns(config: ResolvedConfig): string[] {
  const patterns = new Set<string>();
  let hasRunOnlyRule = false;
  for (const rule of config.rules) {
    if (rule.perFile !== undefined) {
      for (const pattern of rule.perFile.patterns) patterns.add(pattern);
    }
    if (rule.project !== undefined) {
      for (const pattern of rule.project.patterns) patterns.add(pattern);
    }
    if (rule.perFile === undefined && rule.project === undefined) hasRunOnlyRule = true;
  }
  if (hasRunOnlyRule) patterns.add('**/*');
  return [...patterns];
}

/** Narrows a full file list to the files at least one rule could touch. */
export function candidateFileRefs(
  all: readonly string[],
  config: ResolvedConfig,
): FileRef[] {
  const patterns = rulePatterns(config);
  if (patterns.length === 0) return [];
  return all
    .filter((path) => micromatch.isMatch(path, patterns, { dot: true }))
    .map((path) => ({
      path,
      absolutePath: nodePath.resolve(config.projectRoot, path),
    }));
}

/**
 * Enumerates every file any rule could touch. Kept as a single entry point for
 * callers (and tests) that do not need the full project listing.
 */
export async function discoverCandidateFiles(config: ResolvedConfig): Promise<FileRef[]> {
  const all = await listProjectFiles(config.projectRoot);
  return candidateFileRefs(all, config);
}

/**
 * Which test files a run should execute.
 *
 * A test runner answers about the project, not about a file, so a scoped run used
 * to be impossible: `vitest run --project unit` ran the whole suite — 56 seconds
 * in the repository this was measured on — however narrow the request was.
 *
 * Running the tests that cover the files in play is sound as long as the caller
 * says which files it examined and the marks for the rest are left alone. That is
 * what `examinedPaths` is for: skipping a test file must not look like passing it.
 *
 * The mapping is the same one `requireTest` uses — co-located tests, and tests
 * under a `tests/` directory — so a project does not have to describe its layout
 * twice.
 */
import * as nodePath from 'node:path';
import { testCandidates } from '../primitives/checks/fs';

/** Conventions every test runner in this repository follows. */
export const DEFAULT_TEST_SUFFIXES: readonly string[] = [
  '.test.ts',
  '.test.tsx',
  '.spec.ts',
  '.spec.tsx',
  '.test.js',
  '.test.jsx',
  '.test.mts',
  '.test.mjs',
  '.test.php',
];

export interface TestScopeOptions {
  /** Project root, for turning relative paths absolute and back. */
  readonly rootDir: string;
  /** Directory the runner is invoked from; returned paths are relative to it. */
  readonly cwd: string;
  /** Paths in play: what the caller asked for, else what changed. */
  readonly wantedPaths: readonly string[];
  readonly suffixes?: readonly string[] | undefined;
  /** Whether a path exists, by repo-relative path or cwd-relative path. */
  readonly exists: (path: string) => Promise<boolean>;
}

/**
 * The test files to run, relative to `cwd`, or null when there is nothing to run.
 *
 * A path that *is* a test file is kept as it is: its own "test of a test" does not
 * exist, and skipping it would mean a changed test was never executed.
 */
export async function testFilesForPaths(options: TestScopeOptions): Promise<string[] | null> {
  const suffixes = options.suffixes ?? DEFAULT_TEST_SUFFIXES;
  const found = new Set<string>();

  for (const wanted of options.wantedPaths) {
    if (suffixes.some((suffix) => wanted.endsWith(suffix))) {
      found.add(nodePath.relative(options.cwd, nodePath.join(options.rootDir, wanted)));
      continue;
    }
    const absolute = nodePath.join(options.rootDir, wanted);
    for (const candidate of testCandidates(absolute, suffixes)) {
      const asRootRelative = nodePath
        .relative(options.rootDir, candidate)
        .split(nodePath.sep)
        .join('/');
      if (await options.exists(asRootRelative))
        found.add(nodePath.relative(options.cwd, candidate));
    }
  }

  if (found.size === 0) return null;
  return [...found].sort();
}

import * as nodePath from 'node:path';
import * as nodeFs from 'node:fs';
import { Effect } from 'effect';
import type { Rule, Violation } from '@gesetz/core';
import { execTool, runWithTempFile, FileFilter, ProjectRoot, resolveToolBin, resolveToolCwd } from '@gesetz/core';
import { parseJUnitXml, junitToViolations } from '@gesetz/junit';

export interface PestOptions {
  /**
   * Path(s) to test files or directories. Passed as positional args to pest.
   * If omitted, pest runs its configured test suite.
   */
  pattern?: string | string[];
  /** Working directory. Default: the project root. */
  cwd?: string;
  /** Path to the pest binary. Default: 'vendor/bin/pest' */
  bin?: string;
  /** Rule label for the violation output */
  label?: string;
  /** Rule id override. Default: 'pest' */
  id?: string;
  /** Additional CLI options to pass through to pest (e.g. ['--parallel']) */
  extraArgs?: readonly string[];
  /** Category for scoring. */
  category?: string;
}

/**
 * Creates a Rule that runs Pest PHP tests and maps failures to Violations.
 *
 * Pest emits JUnit XML via `--log-junit <file>`. This adapter writes the
 * output to a temp file, parses it, and maps failed/errored tests to
 * violations with file paths and line numbers.
 *
 * Requires `pest` to be installed in the target project (typically at
 * `vendor/bin/pest`).
 *
 * @example
 * pest({ label: 'Pest' })
 * pest({ pattern: 'tests/Unit', bin: 'vendor/bin/pest', label: 'Unit tests' })
 */
async function executePest(
  opts: PestOptions,
  id: string,
  bin: string,
  cwd: string,
  patterns: readonly string[] | null,
): Promise<Violation[]> {
  const baseArgs = ['--log-junit', '__TMP__', '--no-progress'];
  if (opts.extraArgs) baseArgs.push(...opts.extraArgs);
  if (patterns) baseArgs.push(...patterns);

  return Effect.runPromise(
    runWithTempFile('gesetz-pest-', 'junit.xml', (tmpFile) =>
      Effect.gen(function* () {
        const args = baseArgs.map((a) => (a === '__TMP__' ? `--log-junit=${tmpFile}` : a));

        yield* execTool(bin, args, cwd, 'pest').pipe(Effect.ignore);

        const xml = yield* Effect.try({
          try: () => nodeFs.readFileSync(tmpFile, 'utf-8'),
          catch: (cause) => cause,
        }).pipe(Effect.catchAll(() => Effect.succeed('')));

        if (!xml) return [];

        const cases = parseJUnitXml(xml, cwd);
        return junitToViolations(cases, id);
      }),
    ),
  );
}

export function pest(opts: PestOptions = {}): Rule {
  const id = opts.id ?? 'pest';
  const description = opts.label ?? 'Pest test suite';
  const defaultPatterns: string[] | null = opts.pattern
    ? Array.isArray(opts.pattern)
      ? [...opts.pattern]
      : [opts.pattern]
    : null;

  const locate = (projectRoot: string): { bin: string; cwd: string } => {
    const cwd = resolveToolCwd(opts.cwd, projectRoot);
    return { bin: resolveToolBin(opts.bin, cwd, ['vendor/bin/pest'], 'vendor/bin/pest'), cwd };
  };

  const run: Rule['run'] = Effect.gen(function* () {
    const fileFilter = yield* FileFilter;
    const { bin, cwd } = locate(yield* ProjectRoot);
    const patterns = fileFilter.patterns !== null && fileFilter.patterns.length > 0
      ? [...fileFilter.patterns]
      : defaultPatterns;

    return yield* Effect.promise(() => executePest(opts, id, bin, cwd, patterns));
  });

  return {
    id,
    description,
    run,
    category: opts.category,
    project: {
      // Test outcomes depend on any source change — conservative.
      patterns: defaultPatterns ?? ['**/*'],
      run: (ctx) => {
        const { bin, cwd } = locate(ctx.rootDir);
        return executePest(opts, id, bin, cwd, defaultPatterns);
      },
    },
  };
}

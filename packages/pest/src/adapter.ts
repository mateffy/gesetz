import * as nodePath from 'node:path';
import * as nodeFs from 'node:fs';
import { Effect } from 'effect';
import type { Rule, Violation } from '@gesetz/core';
import { execTool, runWithTempFile } from '@gesetz/core';
import { parseJUnitXml, junitToViolations } from '@gesetz/junit';

export interface PestOptions {
  /**
   * Path(s) to test files or directories. Passed as positional args to pest.
   * If omitted, pest runs its configured test suite.
   */
  pattern?: string | string[];
  /** Working directory. Default: process.cwd() */
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
export function pest(opts: PestOptions = {}): Rule {
  const id = opts.id ?? 'pest';
  const description = opts.label ?? 'Pest test suite';
  const cwd = nodePath.resolve(opts.cwd ?? process.cwd());
  const bin = opts.bin ?? 'vendor/bin/pest';

  const run: Rule['run'] = Effect.gen(function* () {
    const baseArgs = ['--log-junit', '__TMP__', '--no-progress'];
    if (opts.extraArgs) baseArgs.push(...opts.extraArgs);
    if (opts.pattern) {
      const patterns = Array.isArray(opts.pattern) ? opts.pattern : [opts.pattern];
      baseArgs.push(...patterns);
    }

    return yield* runWithTempFile('gesetz-pest-', 'junit.xml', (tmpFile) =>
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
    );
  });

  return { id, description, run, category: opts.category };
}

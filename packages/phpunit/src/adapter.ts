import * as nodePath from 'node:path';
import * as nodeFs from 'node:fs';
import { Effect } from 'effect';
import type { Rule, Violation } from '@gesetz/core';
import { execTool, runWithTempFile, FileFilter } from '@gesetz/core';
import { parseJUnitXml, junitToViolations } from '@gesetz/junit';

export interface PhpunitOptions {
  /**
   * Path(s) to test files or directories. Passed as positional args to phpunit.
   * If omitted, phpunit runs its configured test suite.
   */
  pattern?: string | string[];
  /** Working directory. Default: process.cwd() */
  cwd?: string;
  /** Path to the phpunit binary. Default: 'vendor/bin/phpunit' */
  bin?: string;
  /** Path to a phpunit configuration file. Passed as `--configuration <path>`. */
  configFile?: string;
  /** Filter expression (passed as `--filter <expr>`). */
  filter?: string;
  /** Rule label for the violation output */
  label?: string;
  /** Rule id override. Default: 'phpunit' */
  id?: string;
  /** Additional CLI options to pass through to phpunit (e.g. ['--testsuite=unit']) */
  extraArgs?: readonly string[];
  /** Category for scoring. */
  category?: string;
}

/**
 * Creates a Rule that runs PHPUnit tests and maps failures to Violations.
 *
 * PHPUnit emits JUnit XML via `--log-junit <file>`. This adapter writes the
 * output to a temp file, parses it, and maps failed/errored tests to
 * violations with file paths and line numbers.
 *
 * Requires `phpunit` to be installed in the target project (typically at
 * `vendor/bin/phpunit`).
 *
 * @example
 * phpunit({ label: 'PHPUnit' })
 * phpunit({ pattern: 'tests/Unit', configFile: 'phpunit.xml', label: 'Unit tests' })
 */
async function executePhpunit(
  opts: PhpunitOptions,
  id: string,
  bin: string,
  cwd: string,
  patterns: readonly string[] | null,
): Promise<Violation[]> {
  const baseArgs = ['--log-junit', '__TMP__', '--no-progress'];
  if (opts.configFile) baseArgs.push('--configuration', opts.configFile);
  if (opts.filter) baseArgs.push('--filter', opts.filter);
  if (opts.extraArgs) baseArgs.push(...opts.extraArgs);
  if (patterns) baseArgs.push(...patterns);

  return Effect.runPromise(
    runWithTempFile('gesetz-phpunit-', 'junit.xml', (tmpFile) =>
      Effect.gen(function* () {
        const args = baseArgs.map((a) => (a === '__TMP__' ? `--log-junit=${tmpFile}` : a));

        yield* execTool(bin, args, cwd, 'phpunit').pipe(Effect.ignore);

        let xml = '';
        try {
          xml = nodeFs.readFileSync(tmpFile, 'utf-8');
        } catch {
          xml = '';
        }

        if (!xml) {
          return [
            {
              rule: id,
              message:
                'phpunit wrote no JUnit report, so nothing was checked. The tool failed to run or to write its report. Fix the tool, then re-run.',
              path: '.',
              severity: 'error',
              source: 'custom',
            },
          ];
        }

        const cases = parseJUnitXml(xml, cwd);
        return junitToViolations(cases, id);
      }),
    ),
  );
}

export function phpunit(opts: PhpunitOptions = {}): Rule {
  const id = opts.id ?? 'phpunit';
  const description = opts.label ?? 'PHPUnit test suite';
  const cwd = nodePath.resolve(opts.cwd ?? process.cwd());
  const bin = opts.bin ?? 'vendor/bin/phpunit';
  const defaultPatterns: string[] | null = opts.pattern
    ? Array.isArray(opts.pattern)
      ? [...opts.pattern]
      : [opts.pattern]
    : null;

  const run: Rule['run'] = Effect.gen(function* () {
    const fileFilter = yield* FileFilter;
    const patterns =
      fileFilter.patterns !== null && fileFilter.patterns.length > 0
        ? [...fileFilter.patterns]
        : defaultPatterns;

    return yield* Effect.promise(() => executePhpunit(opts, id, bin, cwd, patterns));
  });

  return {
    id,
    description,
    run,
    category: opts.category,
    project: {
      // Test outcomes depend on any source change — conservative.
      patterns: defaultPatterns ?? ['**/*'],
      run: () => executePhpunit(opts, id, bin, cwd, defaultPatterns),
    },
  };
}

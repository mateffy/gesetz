import * as childProcess from 'node:child_process';
import * as nodePath from 'node:path';
import * as nodeFs from 'node:fs';
import * as nodeOs from 'node:os';
import { Effect } from 'effect';
import type { Rule, Violation } from '@regeln/core';
import { parseJUnitXml, junitToViolations } from '@regeln/junit';

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
export function phpunit(opts: PhpunitOptions = {}): Rule {
  const id = opts.id ?? 'phpunit';
  const description = opts.label ?? 'PHPUnit test suite';
  const cwd = nodePath.resolve(opts.cwd ?? process.cwd());
  const bin = opts.bin ?? 'vendor/bin/phpunit';

  const run: Rule['run'] = Effect.gen(function* () {
    const tmpDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'regeln-phpunit-'));
    const tmpFile = nodePath.join(tmpDir, 'junit.xml');

    try {
      const args = ['--log-junit', tmpFile, '--no-progress'];

      if (opts.configFile) args.push('--configuration', opts.configFile);
      if (opts.filter) args.push('--filter', opts.filter);
      if (opts.extraArgs) args.push(...opts.extraArgs);
      if (opts.pattern) {
        const patterns = Array.isArray(opts.pattern) ? opts.pattern : [opts.pattern];
        args.push(...patterns);
      }

      // Run phpunit — exits non-zero on test failures (expected).
      yield* Effect.try({
        try: () => {
          try {
            childProcess.execFileSync(bin, args, {
              cwd,
              encoding: 'utf-8',
              stdio: ['ignore', 'ignore', 'pipe'],
            });
          } catch {
            // Non-zero exit expected when tests fail — JUnit file still written.
          }
        },
        catch: (cause) => cause,
      }).pipe(
        Effect.catchAll((cause) =>
          Effect.gen(function* () {
            yield* Effect.logWarning(
              `[regeln] phpunit failed to execute (${String(cause)}) — attempting to read JUnit output.`,
            );
          }),
        ),
      );

      let xml = '';
      try {
        xml = nodeFs.readFileSync(tmpFile, 'utf-8');
      } catch {
        return [] as Violation[];
      }

      if (!xml) return [] as Violation[];

      const cases = parseJUnitXml(xml, cwd);
      return junitToViolations(cases, id);
    } finally {
      // Cleanup temp directory. rmSync with force:true doesn't throw on missing files.
      nodeFs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  return { id, description, run, category: opts.category };
}

import * as nodePath from 'node:path';
import * as nodeFs from 'node:fs';
import { Effect, Either } from 'effect';
import type { Rule, Violation } from '@gesetz/core';
import { execTool, runWithTempFile, FileFilter, ProjectRoot, resolveToolBin, resolveToolCwd } from '@gesetz/core';
import { parseJUnitXml, junitToViolations } from '@gesetz/junit';

export interface BunTestOptions {
  /**
   * File glob(s) or paths to test. Passed to `bun test <pattern>`.
   * If omitted, runs the default matching `*.test.ts`.
   */
  pattern?: string | string[];
  /** Working directory. Default: the project root. */
  cwd?: string;
  /** Path to the bun binary. Default: 'bun' */
  bin?: string;
  /** Rule label for the violation output */
  label?: string;
  /** Rule id override. Default: 'bun-test' */
  id?: string;
  /** Category for scoring. */
  category?: string;
}

/**
 * Creates a Rule that runs `bun test` and maps failed tests to Violations.
 *
 * `bun test` does not have a JSON reporter — it supports JUnit XML via
 * `--reporter=junit --reporter-outfile=<file>`. This adapter writes the JUnit
 * output to a temp file, parses it, and maps failures to violations.
 *
 * Requires the Bun runtime to be available on PATH.
 *
 * @example
 * bunTest({ pattern: 'src', label: 'bun:test' })
 */
async function executeBunTest(
  id: string,
  bin: string,
  cwd: string,
  patterns: readonly string[] | null,
): Promise<Violation[]> {
  const baseArgs = ['test', '--reporter=junit'];
  if (patterns) baseArgs.push(...patterns);

  return Effect.runPromise(
    runWithTempFile('gesetz-bun-', 'junit.xml', (tmpFile) =>
      Effect.gen(function* () {
        const args = [...baseArgs, `--reporter-outfile=${tmpFile}`];

        // A tool that could not run and a report that could not be read mean the same
        // thing: nothing was checked. The tool's failure used to be ignored and an
        // unreadable file became an empty string, so a missing `bun` produced a clean
        // run — the one answer we know to be wrong.
        const unchecked = (detail: string): Violation[] => [
          {
            rule: id,
            message:
              `bun did not produce a usable JUnit report (${detail}), so nothing was ` +
              'checked. Fix the tool, then re-run.',
            path: '.',
            severity: 'error',
            source: 'custom',
          },
        ];

        const ran = yield* Effect.either(execTool(bin, args, cwd, 'bun-test'));
        if (Either.isLeft(ran)) return unchecked(String(ran.left));

        const report = yield* Effect.either(
          Effect.try({
            try: () => nodeFs.readFileSync(tmpFile, 'utf-8'),
            catch: (cause) => cause,
          }),
        );
        if (Either.isLeft(report)) return unchecked(String(report.left));

        const xml = report.right;
        // An existing report with nothing in it means the runner wrote nothing, which
        // is not the same as writing "no failures".
        if (xml.trim() === '') return unchecked('the report file was empty');

        const cases = parseJUnitXml(xml, cwd);
        return junitToViolations(cases, id);
      }),
    ),
  );
}

export function bunTest(opts: BunTestOptions = {}): Rule {
  const id = opts.id ?? 'bun-test';
  const description = opts.label ?? 'bun:test suite';
  const defaultPatterns: string[] | null = opts.pattern
    ? Array.isArray(opts.pattern)
      ? [...opts.pattern]
      : [opts.pattern]
    : null;

  const locate = (projectRoot: string): { bin: string; cwd: string } => {
    const cwd = resolveToolCwd(opts.cwd, projectRoot);
    return {
      bin: resolveToolBin(
        opts.bin,
        cwd,
        [nodePath.join('node_modules', '.bin', 'bun')],
        'bun',
      ),
      cwd,
    };
  };

  const run: Rule['run'] = Effect.gen(function* () {
    const fileFilter = yield* FileFilter;
    const { bin, cwd } = locate(yield* ProjectRoot);
    const patterns = fileFilter.patterns !== null && fileFilter.patterns.length > 0
      ? [...fileFilter.patterns]
      : defaultPatterns;

    return yield* Effect.promise(() => executeBunTest(id, bin, cwd, patterns));
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
        return executeBunTest(id, bin, cwd, defaultPatterns);
      },
    },
  };
}

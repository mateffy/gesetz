import * as nodePath from 'node:path';
import * as nodeFs from 'node:fs';
import { Effect } from 'effect';
import type { Rule, Violation } from '@regeln/core';
import { execTool, runWithTempFile } from '@regeln/core';
import { parseJUnitXml, junitToViolations } from '@regeln/junit';

export interface BunTestOptions {
  /**
   * File glob(s) or paths to test. Passed to `bun test <pattern>`.
   * If omitted, runs the default matching `*.test.ts`.
   */
  pattern?: string | string[];
  /** Working directory. Default: process.cwd() */
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
export function bunTest(opts: BunTestOptions = {}): Rule {
  const id = opts.id ?? 'bun-test';
  const description = opts.label ?? 'bun:test suite';
  const cwd = nodePath.resolve(opts.cwd ?? process.cwd());
  const bin = opts.bin ?? 'bun';

  const run: Rule['run'] = Effect.gen(function* () {
    const baseArgs = ['test', '--reporter=junit'];
    if (opts.pattern) {
      const patterns = Array.isArray(opts.pattern) ? opts.pattern : [opts.pattern];
      baseArgs.push(...patterns);
    }

    return yield* runWithTempFile('regeln-bun-', 'junit.xml', (tmpFile) =>
      Effect.gen(function* () {
        const args = [...baseArgs, `--reporter-outfile=${tmpFile}`];

        yield* execTool(bin, args, cwd, 'bun-test').pipe(Effect.ignore);

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

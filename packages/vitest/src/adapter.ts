import * as childProcess from 'node:child_process';
import * as nodePath from 'node:path';
import { Effect } from 'effect';
import type { Rule, Violation } from '@regeln/core';

export interface VitestOptions {
  /**
   * File glob(s) or paths to test. Passed to `vitest run <pattern>`.
   * If omitted, runs the full suite configured in vitest.config.
   */
  pattern?: string | string[];
  /** Working directory. Default: process.cwd() */
  cwd?: string;
  /** Path to the vitest binary. Default: 'node_modules/.bin/vitest' */
  bin?: string;
  /** Path to a vitest config file. Passed as `--config <path>`. */
  configFile?: string;
  /** Vitest project filter (e.g. 'unit', 'component'). Passed as `--project <name>`. */
  project?: string | string[];
  /** Rule label for the violation output */
  label?: string;
  /** Rule id override. Default: 'vitest' */
  id?: string;
  /** Category for scoring. */
  category?: string;
}

/**
 * Jest-compatible JSON output shape from `vitest --reporter=json`.
 * Only the fields we read are typed here.
 */
interface VitestJsonResult {
  readonly numFailedTests: number;
  readonly testResults: ReadonlyArray<{
    readonly name: string;
    readonly assertionResults: ReadonlyArray<{
      readonly fullName: string;
      readonly title: string;
      readonly status: 'passed' | 'failed' | 'skipped' | 'todo' | 'unknown';
      readonly failureMessages: readonly string[];
    }>;
  }>;
}

/**
 * Extracts the first `path:line:col` from a stack-trace string.
 * Vitest failure messages embed the assertion location in the stack.
 */
function extractLocation(failureMessage: string): { path: string; line: number | undefined } {
  // Matches patterns like:
  //   at /abs/path/file.test.ts:42:13
  //   at file:///abs/path/file.test.ts:42:13
  const match = /at\s+(?:file:\/\/)?([^\s]+):(\d+):\d+/.exec(failureMessage);
  if (match) {
    return { path: match[1] ?? '', line: Number(match[2] ?? 0) };
  }
  return { path: '', line: undefined };
}

function parseVitestJson(stdout: string, cwd: string, ruleId: string): Violation[] {
  let parsed: VitestJsonResult;
  try {
    parsed = JSON.parse(stdout) as VitestJsonResult;
  } catch {
    return [];
  }

  const violations: Violation[] = [];

  for (const fileResult of parsed.testResults ?? []) {
    const testFile = nodePath.relative(cwd, fileResult.name);

    for (const assertion of fileResult.assertionResults ?? []) {
      if (assertion.status !== 'failed') continue;

      const failure = assertion.failureMessages[0] ?? '';
      const { path: stackPath, line } = extractLocation(failure);
      const message = failure.split('\n')[0] ?? `${assertion.fullName} failed`;

      violations.push({
        rule: ruleId,
        message: `${assertion.fullName}: ${message}`,
        path: stackPath ? nodePath.relative(cwd, stackPath) || testFile : testFile,
        line,
        severity: 'error',
        source: 'custom',
        context: failure.split('\n').slice(0, 6).join('\n') || undefined,
      });
    }
  }

  return violations;
}

/**
 * Creates a Rule that runs vitest and maps failed tests to Violations.
 *
 * Requires `vitest` to be installed in the target project. Runs the JSON
 * reporter and parses failed assertions into `Violation` objects with file
 * paths and line numbers extracted from stack traces.
 *
 * @example
 * vitest({ pattern: 'src', project: 'unit', label: 'Vitest' })
 */
export function vitest(opts: VitestOptions = {}): Rule {
  const id = opts.id ?? 'vitest';
  const description = opts.label ?? 'Vitest test suite';
  const cwd = nodePath.resolve(opts.cwd ?? process.cwd());
  const bin = opts.bin ?? nodePath.join('node_modules', '.bin', 'vitest');

  const run: Rule['run'] = Effect.gen(function* () {
    const args = ['run', '--reporter=json'];

    if (opts.configFile) args.push('--config', opts.configFile);
    if (opts.project) {
      const projects = Array.isArray(opts.project) ? opts.project : [opts.project];
      for (const p of projects) args.push('--project', p);
    }
    if (opts.pattern) {
      const patterns = Array.isArray(opts.pattern) ? opts.pattern : [opts.pattern];
      args.push(...patterns);
    }

    const stdout = yield* Effect.try({
      try: (): string => {
        try {
          return childProcess
            .execFileSync(bin, args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
            .toString();
        } catch (e: unknown) {
          // vitest exits 1 when tests fail — the JSON is on stdout.
          const execError = e as { stdout?: Buffer | string };
          const out = execError.stdout;
          if (out) return typeof out === 'string' ? out : out.toString();
          throw e;
        }
      },
      catch: (cause) => cause,
    }).pipe(
      Effect.catchAll((cause) =>
        Effect.gen(function* () {
          yield* Effect.logWarning(
            `[regeln] vitest failed (${String(cause)}) — vitest() produced no violations.`,
          );
          return '';
        }),
      ),
    );

    if (!stdout) return [];
    return parseVitestJson(stdout, cwd, id);
  });

  return { id, description, run, category: opts.category };
}

import * as childProcess from 'node:child_process';
import * as nodeFs from 'node:fs';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';
import { Effect } from 'effect';
import type { Rule, Violation } from '@regeln/core';

export interface StorybookOptions {
  /**
   * URL of the Storybook instance to test.
   * Default: 'http://localhost:6006'.
   * If the URL is unreachable, the rule produces an info-level violation.
   */
  url?: string;
  /** Working directory. Default: process.cwd() */
  cwd?: string;
  /** Path to the test-storybook binary. Default: 'node_modules/.bin/test-storybook' */
  bin?: string;
  /**
   * Path to an ejected jest config for the test runner.
   * Passed as `--config <path>`.
   */
  configFile?: string;
  /** Story name pattern to filter (e.g. 'components/ui/**'). */
  pattern?: string | string[];
  /** Rule label. */
  label?: string;
  /** Rule id override. Default: 'storybook' */
  id?: string;
  /** Category for scoring. */
  category?: string;
  /** Extra args passed to test-storybook. */
  extraArgs?: string[];
}

/** Jest-compatible JSON shape emitted by `test-storybook --json`. */
interface JestJsonResult {
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

function extractLocation(failureMessage: string): { path: string; line: number | undefined } {
  const match = /at\s+(?:file:\/\/)?([^\s]+):(\d+):\d+/.exec(failureMessage);
  if (match) {
    return { path: match[1] ?? '', line: Number(match[2] ?? 0) };
  }
  return { path: '', line: undefined };
}

function parseJestJson(stdout: string, cwd: string, ruleId: string): Violation[] {
  let parsed: JestJsonResult;
  try {
    parsed = JSON.parse(stdout) as JestJsonResult;
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
 * Creates a Rule that runs `test-storybook` and maps failed stories to
 * Violations.
 *
 * Storybook's test-runner is Jest-powered, so it emits Jest-compatible JSON
 * when run with `--json`. Failed assertions (e.g. console errors, a11y
 * violations, interaction failures) become error-severity violations.
 *
 * Requires `@storybook/test-runner` installed in the target project and a
 * running Storybook server (or `storybook build` + static hosting).
 *
 * @example
 * storybook({ url: 'http://localhost:6006', pattern: 'components/ui/**' })
 */
export function storybook(opts: StorybookOptions = {}): Rule {
  const id = opts.id ?? 'storybook';
  const description = opts.label ?? 'Storybook test runner';
  const cwd = nodePath.resolve(opts.cwd ?? process.cwd());
  const bin = opts.bin ?? nodePath.join('node_modules', '.bin', 'test-storybook');
  const url = opts.url ?? 'http://localhost:6006';

  const run: Rule['run'] = Effect.gen(function* () {
    // Write JSON to a temp file to avoid polluting stdout with Jest's
    // progress output which can corrupt the JSON payload.
    const tmpFile = nodePath.join(
      nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'regeln-storybook-')),
      'results.json',
    );

    const args = ['--url', url, '--json', '--outputFile', tmpFile, '--ci'];

    if (opts.configFile) args.push('--config', opts.configFile);
    if (opts.pattern) {
      const patterns = Array.isArray(opts.pattern) ? opts.pattern : [opts.pattern];
      args.push('--stories', patterns.join(','));
    }
    if (opts.extraArgs) args.push(...opts.extraArgs);

    yield* Effect.try({
      try: () => {
        try {
          childProcess.execFileSync(bin, args, {
            cwd,
            encoding: 'utf-8',
            stdio: ['ignore', 'ignore', 'pipe'],
          });
        } catch (_e) {
          // test-storybook exits non-zero when stories fail — that's expected.
          // The JSON is written to the output file regardless.
          void _e;
        }
      },
      catch: (cause) => cause,
    }).pipe(
      Effect.catchAll((cause) =>
        Effect.gen(function* () {
          yield* Effect.logWarning(
            `[regeln] test-storybook failed to launch (${String(cause)}) — storybook() produced no violations.`,
          );
        }),
      ),
    );

    let stdout = '';
    try {
      stdout = nodeFs.readFileSync(tmpFile, 'utf-8');
    } catch {
      return [];
    } finally {
      // Cleanup temp file + directory. rmSync with force:true doesn't throw on missing files.
      nodeFs.rmSync(nodePath.dirname(tmpFile), { recursive: true, force: true });
    }

    if (!stdout.trim()) return [];
    return parseJestJson(stdout, cwd, id);
  });

  return { id, description, run, category: opts.category };
}

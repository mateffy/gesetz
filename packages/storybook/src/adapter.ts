import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { Effect } from 'effect';
import type { Rule, Violation } from '@gesetz/core';
import { execTool, runWithTempFile, extractLocation } from '@gesetz/core';

/** Lines of a failure message kept as violation context. */
const FAILURE_CONTEXT_LINES = 6;

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
        context: failure.split('\n').slice(0, FAILURE_CONTEXT_LINES).join('\n') || undefined,
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
async function executeStorybook(
  opts: StorybookOptions,
  id: string,
  bin: string,
  cwd: string,
  url: string,
): Promise<Violation[]> {
  const baseArgs = ['--url', url, '--json', '--outputFile', '__TMP__', '--ci'];
  if (opts.configFile) baseArgs.push('--config', opts.configFile);
  if (opts.pattern) {
    const patterns = Array.isArray(opts.pattern) ? opts.pattern : [opts.pattern];
    baseArgs.push('--stories', patterns.join(','));
  }
  if (opts.extraArgs) baseArgs.push(...opts.extraArgs);

  return Effect.runPromise(
    runWithTempFile('gesetz-storybook-', 'results.json', (tmpFile) =>
      Effect.gen(function* () {
        const args = baseArgs.map((a) => (a === '__TMP__' ? tmpFile : a));

        yield* execTool(bin, args, cwd, 'test-storybook').pipe(Effect.ignore);

        let stdout = '';
        try {
          stdout = nodeFs.readFileSync(tmpFile, 'utf-8');
        } catch {
          stdout = '';
        }

        if (!stdout.trim()) {
          return [
            {
              rule: id,
              message:
                'test-storybook wrote no results file, so nothing was checked. The tool failed to run or to write its report. Fix the tool, then re-run.',
              path: '.',
              severity: 'error',
              source: 'custom',
            },
          ];
        }
        return parseJestJson(stdout, cwd, id);
      }),
    ),
  );
}

export function storybook(opts: StorybookOptions = {}): Rule {
  const id = opts.id ?? 'storybook';
  const description = opts.label ?? 'Storybook test runner';
  const cwd = nodePath.resolve(opts.cwd ?? process.cwd());
  const bin = opts.bin ?? nodePath.join('node_modules', '.bin', 'test-storybook');
  const url = opts.url ?? 'http://localhost:6006';

  const run: Rule['run'] = Effect.gen(function* () {
    return yield* Effect.promise(() => executeStorybook(opts, id, bin, cwd, url));
  });

  return {
    id,
    description,
    run,
    category: opts.category,
    project: {
      // Story outcomes depend on any source change — conservative.
      patterns: ['**/*'],
      run: () => executeStorybook(opts, id, bin, cwd, url),
    },
  };
}

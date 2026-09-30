import * as nodePath from 'node:path';
import * as nodeFs from 'node:fs';
import { Effect } from 'effect';
import type { ProjectRuleContext, Rule, Violation } from '@gesetz/core';
import {
  FileFilter,
  execTool,
  extractLocation,
  runWithTempFile,
  testFilesForPaths,
  toolWatchPatterns,
} from '@gesetz/core';

/** Lines of a failure message kept as violation context. */
const FAILURE_CONTEXT_LINES = 6;

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
  /**
   * Test file suffixes this project uses, for matching a source file to its test.
   * Defaults to the conventions every adapter in this repository follows
   * (`.test.ts`, `.spec.ts`, `.test.tsx`, `.test.js`, …).
   */
  testSuffixes?: string[];
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

function parseVitestJson(report: string, cwd: string, ruleId: string): Violation[] {
  let parsed: VitestJsonResult;
  try {
    parsed = JSON.parse(report) as VitestJsonResult;
  } catch (cause) {
    return [
      {
        rule: ruleId,
        message: `vitest produced output that is not a JSON report, so nothing was checked: ${String(cause)}. Fix the tool, then re-run.`,
        path: '.',
        severity: 'error',
        source: 'custom',
      },
    ];
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
 * The test files to run for a scan, or null when none of the files in play have
 * tests.
 *
 * Paths come back relative to the runner's own directory, because that is where
 * the tool is invoked from and vitest matches its filters against its cwd.
 *
 * Existence is checked on disk: the engine's rule context carries the files in play,
 * not the whole project listing.
 */
async function testsToRun(
  ctx: ProjectRuleContext,
  opts: VitestOptions,
  cwd: string,
): Promise<string[] | null> {
  const wanted = ctx.requestedPaths ?? ctx.changedFiles;
  if (wanted.length === 0) return null;
  const nodeFs = await import('node:fs');
  const nodePath = await import('node:path');
  return testFilesForPaths({
    rootDir: ctx.rootDir,
    cwd,
    wantedPaths: wanted,
    ...(opts.testSuffixes === undefined ? {} : { suffixes: opts.testSuffixes }),
    exists: async (path) => nodeFs.existsSync(nodePath.join(ctx.rootDir, path)),
  });
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
/**
 * Keep only the patterns vitest can actually match, and drop the rest.
 *
 * A scope made of PHP paths — `../app/Domains/API/Immoui/Communication/`, which
 * is what a gesetz `--files` list produces for a PHP batch — matches no test
 * file. Vitest does not then run nothing: with a positional pattern that matches
 * nothing it falls back to its default include and runs **the whole suite**. A
 * scoped check that was meant to take seconds took 25 minutes, twenty agents at
 * a time, because one rule in the run could not read the scope as a scope.
 *
 * A pattern is usable when it resolves inside vitest's own cwd or is a bare
 * glob. Anything outside — another package, a PHP tree, an absolute path
 * elsewhere — is not something this rule can run tests for.
 */
function usablePatterns(
  patterns: readonly string[] | null,
  cwd: string,
): string[] | null | 'skip' {
  // No scope at all means an unscoped run, and running everything is correct.
  if (!patterns || patterns.length === 0) return null;

  const kept = patterns.filter((p) => {
    if (p.startsWith('!')) return false;
    if (!p.startsWith('.') && !nodePath.isAbsolute(p)) return true;
    const resolved = nodePath.resolve(cwd, p);
    const rel = nodePath.relative(cwd, resolved);
    return rel !== '' && !rel.startsWith('..') && !nodePath.isAbsolute(rel);
  });

  // A scope was given and none of it is testable from here. Returning null here
  // would run the whole suite — the exact failure this guards against — so the
  // rule reports nothing examined instead. A scope that cannot be read as a
  // scope must not be widened into "everything".
  return kept.length > 0 ? kept : 'skip';
}

async function executeVitest(
  opts: VitestOptions,
  id: string,
  bin: string,
  cwd: string,
  patterns: readonly string[] | null,
): Promise<Violation[]> {
  const usable = usablePatterns(patterns, cwd);
  if (usable === 'skip') return [];
  patterns = usable;
  return Effect.runPromise(
    runWithTempFile('gesetz-vitest-', 'report.json', (tmpFile) =>
      Effect.gen(function* () {
        const args: string[] = ['run', '--reporter=json', `--outputFile=${tmpFile}`];

        if (opts.configFile) args.push('--config', opts.configFile);
        if (opts.project) {
          const projects = Array.isArray(opts.project) ? opts.project : [opts.project];
          for (const p of projects) args.push('--project', p);
        }
        if (patterns) args.push(...patterns);

        // A failing test run exits non-zero, which is the expected case here: the
        // report file is the result, not the exit code. So the exit is ignored and
        // the file is read instead.
        yield* execTool(bin, args, cwd, 'vitest').pipe(Effect.ignore);

        let json = '';
        try {
          json = nodeFs.readFileSync(tmpFile, 'utf-8');
        } catch {
          json = '';
        }

        if (!json.trim()) {
          return [
            {
              rule: id,
              message:
                'vitest wrote no JSON report, so nothing was checked. The tool failed to run or to write its report. Fix the tool, then re-run.',
              path: '.',
              severity: 'error',
              source: 'custom',
            },
          ];
        }

        return parseVitestJson(json, cwd, id);
      }),
    ),
  );
}

export function vitest(opts: VitestOptions = {}): Rule {
  const id = opts.id ?? 'vitest';
  const description = opts.label ?? 'Vitest test suite';
  const cwd = nodePath.resolve(opts.cwd ?? process.cwd());
  const bin = opts.bin ?? nodePath.join('node_modules', '.bin', 'vitest');
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

    return yield* Effect.promise(() => executeVitest(opts, id, bin, cwd, patterns));
  });

  return {
    id,
    description,
    run,
    category: opts.category,
    project: {
      // Test outcomes depend on any source change — conservative: re-run
      // whenever anything changed, skip only zero-change runs.
      patterns: toolWatchPatterns(defaultPatterns ?? ['.']),
      run: async (ctx) => {
        // Run the tests that cover the files in play, not the whole suite. A
        // whole-suite run costs what the project costs — 56 seconds, measured on
        // a large repository — however narrow the request was; the tests for one
        // file cost what that file costs.
        const scope = await testsToRun(ctx, opts, cwd);
        if (scope === null) return { violations: [], examinedPaths: [] };
        const violations = await executeVitest(opts, id, bin, cwd, scope);
        // Reporting which files were examined is what keeps the marks for the
        // tests that did *not* run: skipping a test must not look like passing it.
        return { violations, examinedPaths: scope };
      },
    },
  };
}

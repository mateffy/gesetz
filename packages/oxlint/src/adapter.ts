import * as nodePath from 'node:path';
import { Effect } from 'effect';
import type { Rule, Violation } from '@gesetz/core';
import { FileFilter, execTool, scopedPatterns, toolWatchPatterns } from '@gesetz/core';

export interface OxlintOptions {
  pattern?: string | string[];
  cwd?: string;
  bin?: string;
  configFile?: string;
  label?: string;
  id?: string;
  category?: string;
}

interface OxlintSpan {
  line?: number;
  column?: number;
}

interface OxlintLabel {
  span?: OxlintSpan;
}

interface OxlintDiagnostic {
  message: string;
  code?: string;
  filename: string;
  severity?: 'error' | 'warning' | 'advice';
  labels?: OxlintLabel[];
}

interface OxlintJsonOutput {
  diagnostics?: OxlintDiagnostic[];
}

/**
 * Creates a Rule that runs oxlint and maps output to Violations.
 * Requires `oxlint` to be available on PATH or as a local binary.
 *
 * @example
 * oxlint({ pattern: 'src/**\/*.ts', label: 'oxlint' })
 */
async function executeOxlint(
  opts: OxlintOptions,
  id: string,
  bin: string,
  cwd: string,
  patterns: readonly string[],
): Promise<Violation[]> {
  const args = ['--format=json', ...patterns];
  if (opts.configFile) args.push('--config', opts.configFile);

  const stdout = await Effect.runPromise(
    execTool(bin, args, cwd, 'oxlint', { requireStdout: true }),
  );

  // Empty stdout without a non-zero exit is a clean run: oxlint writes nothing
  // when it finds nothing. A non-zero exit with empty stdout already died in
  // execTool.
  if (!stdout.trim()) return [];

  let output: OxlintJsonOutput;
  try {
    output = JSON.parse(stdout) as OxlintJsonOutput;
  } catch (cause) {
    return [
      {
        rule: id,
        message: `oxlint produced output that is not a JSON report, so nothing was checked: ${String(cause)}. Fix the tool, then re-run.`,
        path: '.',
        severity: 'error',
        source: 'oxlint',
      },
    ];
  }

  const diagnostics = output.diagnostics ?? [];

  return diagnostics.map((diag): Violation => {
    const span = diag.labels?.[0]?.span;
    const severity: Violation['severity'] = diag.severity === 'warning' ? 'warn' : 'error';

    const ruleCode = diag.code ?? 'oxlint';

    // oxlint reports filenames relative to cwd — resolve to absolute first.
    const absFilename = nodePath.isAbsolute(diag.filename)
      ? diag.filename
      : nodePath.resolve(cwd, diag.filename);

    return {
      rule: id,
      message: `${ruleCode}: ${diag.message}`,
      path: nodePath.relative(cwd, absFilename),
      line: span?.line,
      column: span?.column,
      severity,
      source: 'oxlint',
    };
  });
}

export function oxlint(opts: OxlintOptions = {}): Rule {
  const id = opts.id ?? 'oxlint';
  const description = opts.label ?? 'oxlint';
  const bin = opts.bin ?? 'oxlint';
  const cwd = nodePath.resolve(opts.cwd ?? process.cwd());
  const defaultPatterns: string[] = opts.pattern
    ? Array.isArray(opts.pattern)
      ? [...opts.pattern]
      : [opts.pattern]
    : ['.'];

  const run: Rule['run'] = Effect.gen(function* () {
    const fileFilter = yield* FileFilter;

    const patterns: string[] =
      fileFilter.patterns !== null && fileFilter.patterns.length > 0
        ? [...fileFilter.patterns]
        : defaultPatterns;

    return yield* Effect.promise(() => executeOxlint(opts, id, bin, cwd, patterns));
  });

  return {
    id,
    description,
    run,
    category: opts.category,
    project: {
      patterns: toolWatchPatterns([...defaultPatterns, '.oxlintrc*', 'oxlint.config.*']),
      run: (ctx) => {
        // A linter's answer for a file depends only on that file; see the note in
        // the oxfmt adapter about why examinedPaths must be reported.
        const scoped = scopedPatterns(ctx.changedFiles, defaultPatterns);
        if (scoped === null) return Promise.resolve({ violations: [], examinedPaths: [] });
        return executeOxlint(opts, id, bin, cwd, scoped).then((violations) => ({
          violations,
          examinedPaths: scoped,
        }));
      },
    },
  };
}

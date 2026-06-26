import * as childProcess from 'node:child_process';
import * as nodePath from 'node:path';
import { Effect } from 'effect';
import type { Rule, Violation } from '@regeln/core';

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
export function oxlint(opts: OxlintOptions = {}): Rule {
  const id = opts.id ?? 'oxlint';
  const description = opts.label ?? 'oxlint';
  const bin = opts.bin ?? 'oxlint';
  const cwd = nodePath.resolve(opts.cwd ?? process.cwd());

  const run: Rule['run'] = Effect.gen(function* () {
    const patterns = opts.pattern
      ? Array.isArray(opts.pattern)
        ? opts.pattern
        : [opts.pattern]
      : ['.'];

    const args = ['--format=json', ...patterns];
    if (opts.configFile) args.push('--config', opts.configFile);

    const stdout = yield* Effect.try({
      try: (): string => {
        try {
          return childProcess
            .execFileSync(bin, args, {
              cwd,
              encoding: 'utf-8',
              stdio: ['ignore', 'pipe', 'pipe'],
            })
            .toString();
        } catch (e: unknown) {
          // oxlint exits non-zero on violations but still writes JSON to stdout
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
            `[regeln] oxlint failed (${String(cause)}) — oxlint() produced no violations.`,
          );
          return '';
        }),
      ),
    );

    if (!stdout.trim()) return [];

    let output: OxlintJsonOutput;
    try {
      output = JSON.parse(stdout) as OxlintJsonOutput;
    } catch {
      return [];
    }

    const diagnostics = output.diagnostics ?? [];

    return diagnostics.map((diag): Violation => {
      const span = diag.labels?.[0]?.span;
      const severity: Violation['severity'] =
        diag.severity === 'warning' ? 'warn' : 'error';

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
  });

  return { id, description, run, category: opts.category };
}

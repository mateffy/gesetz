import { Effect, Layer } from 'effect';
import { Reporter } from './reporter';
import { ReporterError } from '../engine/errors';
import type { RunResult } from '../engine/runner';

/**
 * Emits GitHub Actions workflow commands for each violation.
 * Produces `::error file=...,line=...::message` annotations.
 */
export const GitHubActionsReporter: Layer.Layer<Reporter> = Layer.succeed(Reporter, {
  report: (result: RunResult): Effect.Effect<void, ReporterError> =>
    Effect.try({
      try: () => {
        const violations = result.byRule.flatMap((r) => r.violations);
        for (const v of violations) {
          const level = v.severity === 'warn' ? 'warning' : 'error';
          const parts = [`file=${v.path}`];
          if (v.line !== undefined) parts.push(`line=${v.line}`);
          if (v.column !== undefined) parts.push(`col=${v.column}`);
          process.stdout.write(`::${level} ${parts.join(',')}::${v.message}\n`);
        }
      },
      catch: (cause) => new ReporterError({ cause }),
    }),
});

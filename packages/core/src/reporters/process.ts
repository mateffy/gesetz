import { Effect, Layer } from 'effect';
import { Reporter } from './reporter';
import { ReporterError } from '../engine/errors';
import type { RunResult } from '../engine/runner';

/**
 * Exits the process with code 1 if there are any violations.
 * Useful for CI pipelines and pre-commit hooks.
 */
export const ProcessReporter: Layer.Layer<Reporter> = Layer.succeed(Reporter, {
  report: (result: RunResult): Effect.Effect<void, ReporterError> =>
    Effect.sync(() => {
      const total = result.totalViolations;
      if (total > 0) {
        process.stderr.write(`\nQuality Assurance: ${total} violation(s) found.\n`);
        // Set exit code without short-circuiting finalizers — lets the Effect
        // runtime finish cleanup before the process exits.
        process.exitCode = 1;
      }
    }),
});

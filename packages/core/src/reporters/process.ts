import { Effect, Layer } from 'effect';
import { Reporter } from './reporter';
import { ReporterError } from '../engine/errors';
import type { RunResult } from '../engine/runner';

/**
 * Writes the status banner to stderr and sets exit code 1 when there are
 * violations. The banner lives on stderr so stdout remains a clean data
 * contract (the CLI's `--format` formatters own stdout in every mode).
 */
export const ProcessReporter: Layer.Layer<Reporter> = Layer.succeed(Reporter, {
  report: (result: RunResult): Effect.Effect<void, ReporterError> =>
    Effect.sync(() => {
      const verdict = result.passing ? 'pass' : 'fail';
      process.stderr.write(
        `gesetz: ${verdict} (${result.totalViolations} violation${result.totalViolations === 1 ? '' : 's'})\n`,
      );
      // Set exit code without short-circuiting finalizers — lets the Effect
      // runtime finish cleanup before the process exits.
      if (result.totalViolations > 0) process.exitCode = 1;
    }),
});

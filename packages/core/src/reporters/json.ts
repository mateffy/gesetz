import { Effect, Layer } from 'effect';
import { Reporter } from './reporter';
import { ReporterError } from '../engine/errors';
import type { RunResult } from '../engine/runner';
import type { Violation } from '../engine/rule';

/**
 * Writes all violations as a JSON array to stdout.
 */
export const JsonReporter: Layer.Layer<Reporter> = Layer.succeed(Reporter, {
  report: (result: RunResult): Effect.Effect<void, ReporterError> =>
    Effect.try({
      try: () => {
        const violations: Violation[] = result.byRule.flatMap((r) => r.violations);
        process.stdout.write(JSON.stringify(violations, null, 2) + '\n');
      },
      catch: (cause) => new ReporterError({ cause }),
    }),
});

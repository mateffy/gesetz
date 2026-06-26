import { Context, Effect } from 'effect';
import type { RunResult } from '../engine/runner';
import { ReporterError } from '../engine/errors';

export interface ReporterService {
  report(result: RunResult): Effect.Effect<void, ReporterError>;
}

/**
 * The Reporter service. Always requires an external layer — no default implementation.
 * Use one of: JsonReporter, JUnitReporter, TestRunnerReporter, etc.
 */
export class Reporter extends Context.Tag('qa/Reporter')<Reporter, ReporterService>() {}

export type ReportFn = (result: RunResult) => Effect.Effect<void, ReporterError>;

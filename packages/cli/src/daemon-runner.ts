/**
 * The engine, as the daemon sees it.
 *
 * This is the only file that knows both halves — the daemon's protocol and the
 * engine's run — which is what keeps the server free of check logic and the engine
 * free of daemon awareness.
 */
import { Effect } from 'effect';
import { narrowRunResult, resolveChangedFiles, runAll } from '@gesetz/core';
import type {
  BaselineFile,
  CheckSpec,
  DaemonRun,
  DaemonRunner,
  GesetzStorageConfig,
  ResolvedConfig,
  Rule,
  RunResult,
  Scope,
} from '@gesetz/core';
import { resolveCheckScope } from './check';

export interface DaemonRunnerDeps {
  /** The project's config, as the direct path sees it. */
  readonly config: ResolvedConfig;
  /**
   * Reads the baseline when a request asks for one.
   *
   * A function, not a value: a daemon outlives the file, and a baseline captured at
   * start-up would be served for as long as the process lives — including after the
   * maintainer has written a new one.
   */
  readonly loadBaseline: () => Promise<BaselineFile | null>;
  readonly storage: GesetzStorageConfig;
}

/** Rules the request did not ask for, and which this answer therefore says nothing about. */
export function rulesNotRequested(
  allRules: readonly Rule[],
  requested: readonly Rule[],
): string[] {
  const wanted = new Set(requested.map((rule) => rule.id));
  return allRules
    .filter((rule) => !wanted.has(rule.id))
    .map((rule) => rule.id)
    .sort();
}

export function createDaemonRunner(deps: DaemonRunnerDeps): DaemonRunner<RunResult> {
  const run = async (spec: CheckSpec): Promise<DaemonRun<RunResult>> => {
    // The same narrowing the direct path does. A filter matching no rule throws, and
    // the server turns that into an error answer: a request that cannot be honoured
    // must not be answered with a quiet pass.
    const scope = resolveCheckScope({
      rules: deps.config.rules,
      configuredThresholds: deps.config.thresholds,
      categoryFilter: spec.categories?.join(',') ?? undefined,
      ruleFilter: spec.rules,
      thresholdOverride: undefined,
    });

    const result = await Effect.runPromise(
      runAll(
        {
          ...deps.config,
          rules: scope.rules,
          thresholds: scope.thresholds,
          changedSince: spec.scope.since ?? undefined,
          storage: deps.storage,
        },
        {
          baseline: spec.baseline === 'apply' ? await deps.loadBaseline() : null,
          fileFilter: spec.scope.files,
        },
      ),
    );

    return {
      envelope: result,
      servedFrom: 'recomputed',
      checksNotRun: rulesNotRequested(deps.config.rules, scope.rules),
      computedAt: Date.now(),
    };
  };

  const narrow = (result: RunResult, scopes: { readonly batch: Scope; readonly member: Scope }): RunResult =>
    narrowRunResult(result, {
      fileFilter: scopes.member.files,
      changedPaths:
        scopes.member.since === null
          ? null
          : resolveChangedFiles(scopes.member.since, deps.config.projectRoot),
      thresholds: deps.config.thresholds,
    });

  return { run, narrow };
}

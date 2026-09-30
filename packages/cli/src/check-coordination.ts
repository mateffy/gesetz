/**
 * The parts of `gesetz check` that decided *whether* to run it.
 *
 * Kept out of `main.ts` so the command file stays about wiring: what a run's
 * identity is (`requestKeyFor`), what the caller is told about how it got its
 * result (`describeCoordination`), and how the flags and environment resolve into
 * the coordination knobs (`resolveCoordinationKnobs`).
 */
import { createHash } from 'node:crypto';

/** Milliseconds in a second, for the wait-timeout flag. */
const MS_PER_SECOND = 1000;

/** Hex characters of the request key kept as its id. */
const REQUEST_KEY_LENGTH = 16;
import type { GesetzStorageConfig } from '@gesetz/core';

/**
 * Identifies the question a run answers.
 *
 * Two callers may share a run only when every field that changes the answer
 * agrees: the rules that will run, the thresholds they are scored against, the
 * aggregation filters, the baseline, and whether the cache is in play at all.
 */
export interface RequestKeys {
  /**
   * What was asked, excluding the scope: root, config, rules, thresholds, the
   * baseline, the storage. Two callers with the same instance key are asking the
   * same question, so one run can answer both.
   */
  readonly instanceKey: string;
  /** The scope: the requested paths and the `--since` cut. */
  readonly scopeKey: string;
  /**
   * The scope key a whole-tree run of this instance would have. A record produced
   * under it examined the whole tree, so it can be narrowed to any scope instead
   * of the tree being scanned and checked again.
   */
  readonly fullScopeKey: string;
}

const scopeKeyFor = (
  fileFilter: readonly string[] | null,
  changedSince: string | undefined,
): string =>
  createHash('sha256')
    .update('gesetz-coordination-scope-v1')
    .update(JSON.stringify([fileFilter === null ? null : fileFilter.slice().sort(), changedSince ?? null]))
    .digest('hex')
    .slice(0, REQUEST_KEY_LENGTH);

/** The scope key of a run that examined everything. A constant, by construction. */
export const fullScopeKey = scopeKeyFor(null, undefined);

export const requestKeyFor = (input: {
  root: string;
  configPath: string | undefined;
  rules: readonly { id: string }[];
  thresholds: readonly { category: string; minScore: number }[];
  fileFilter: readonly string[] | null;
  changedSince: string | undefined;
  baselineBytes: string | null;
  storage: GesetzStorageConfig;
}): RequestKeys => ({
  instanceKey: createHash('sha256')
    .update(
      JSON.stringify([
        'gesetz-coordination-v2',
        input.root,
        input.configPath ?? '<default>',
        input.rules.map((rule) => rule.id).sort(),
        input.thresholds.map((threshold) => `${threshold.category}=${threshold.minScore}`).sort(),
        input.baselineBytes === null
          ? null
          : createHash('sha256').update(input.baselineBytes).digest('hex'),
        input.storage.kind === 'sqlite' ? 'sqlite' : 'memory',
      ]),
    )
    .digest('hex')
    .slice(0, REQUEST_KEY_LENGTH),
  scopeKey: scopeKeyFor(input.fileFilter, input.changedSince),
  fullScopeKey,
});

export interface CoordinationKnobs {
  /** How many runs may proceed at once. */
  readonly jobs: number;
  /** Run now: no lock, no waiting, no reuse. */
  readonly standalone: boolean;
  /** How long to wait for a run in flight; undefined means the default. */
  readonly waitTimeoutMs: number | undefined;
}

/**
 * Resolves the knobs from flags and environment in one place, so `--jobs`,
 * `GESETZ_JOBS`, `--standalone`, `GESETZ_LOCK` and `--full` cannot disagree.
 *
 * `--full` implies standalone: a caller that wants no caching wants no sharing
 * either, and that keeps `--full` meaning exactly what it always meant.
 */
export const resolveCoordinationKnobs = (input: {
  flags: {
    readonly standalone: boolean;
    readonly full: boolean;
    readonly jobs: number;
    readonly waitTimeoutSeconds: number | undefined;
  };
  env: Readonly<Record<string, string | undefined>>;
}): CoordinationKnobs => {
  const { flags, env } = input;
  const jobsFromEnv = Number(env['GESETZ_JOBS'] ?? '');
  return {
    jobs: Number.isFinite(jobsFromEnv) && jobsFromEnv > 0 ? Math.floor(jobsFromEnv) : flags.jobs,
    standalone: flags.standalone || flags.full || env['GESETZ_LOCK'] === 'off',
    waitTimeoutMs:
      flags.waitTimeoutSeconds === undefined ? undefined : flags.waitTimeoutSeconds * MS_PER_SECOND,
  };
};

/**
 * The line an agent reads to understand why its result looks the way it does.
 *
 * When several agents share a worktree, a result can describe files this process
 * never touched. The tool cannot know which files each agent edited, so it says
 * what it does know: another process ran the check, other processes waited on
 * it, and how many files were re-checked.
 */
export const describeCoordination = (input: {
  mode: 'ran' | 'reused' | 'ran-after-wait' | 'standalone';
  waitedMs: number;
  /** The work itself. Absent for a reused result, which did no work here. */
  runMs?: number | undefined;
  runAgeMs: number;
  listeners: number;
  recheckedFiles: number;
  runningPid?: number | undefined;
  /**
   * For a reused result: whether it came from this exact scope, or from a
   * whole-tree run that has to be narrowed to this caller's scope.
   */
  reusedScope?: 'same' | 'full' | undefined;
}): string => {
  const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
  const shared =
    input.recheckedFiles > 0
      ? ` — re-checked ${input.recheckedFiles} changed file${input.recheckedFiles === 1 ? '' : 's'}; this worktree is shared, so some results may not be yours`
      : '';
  if (input.mode === 'standalone') return 'coord: standalone — not waiting, not reusing';
  if (input.mode === 'reused') {
    const scope =
      input.reusedScope === 'full'
        ? ' — narrowed from a whole-tree run to your scope'
        : ' — same scope as yours';
    return `coord: reused a run from ${seconds(input.runAgeMs)} ago${scope}${shared}`;
  }
  if (input.mode === 'ran-after-wait') {
    const worked = input.runMs === undefined ? '' : ` ${seconds(input.runMs)}`;
    return `coord: waited ${seconds(input.waitedMs)}${input.runningPid === undefined ? '' : ` for pid ${input.runningPid}`}, then ran${worked}${shared}`;
  }
  const listeners =
    input.listeners > 0
      ? ` — ${input.listeners} other process${input.listeners === 1 ? '' : 'es'} waited on this run`
      : '';
  const took = input.runMs === undefined ? '' : ` (ran ${seconds(input.runMs)})`;
  return `coord: ran — no other gesetz check active${listeners}${took}${shared}`;
};

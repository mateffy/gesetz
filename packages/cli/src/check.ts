/**
 * The `gesetz check` command.
 *
 * Its own module because it is the largest thing the CLI does — options,
 * coordination, rendering — and `main.ts` is the composition root that wires the
 * commands together, not the place for any one of them.
 */
import { Command, Options } from '@effect/cli';
import { Console, Effect, Option } from 'effect';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import {
  runAll,
  baselinePathFor,
  coordinateRun,
  type BaselineFile,
  type CategoryThreshold,
  type CoordinationOutcome,
  type Rule,
  type RunResult,
} from '@gesetz/core';
import { loadConfig } from './load-config';
import { RUNTIME, describeStorage, resolveStorage } from './storage';
import {
  describeCoordination,
  requestKeyFor,
  resolveCoordinationKnobs,
} from './check-coordination';
import { loadBaseline } from './baseline';
import {
  formatCategoryTable,
  formatViolations,
  formatEnvelope,
  formatCi,
  formatStatusBanner,
  detectFormat,
  type OutputFormat,
} from './format';
import { watchForChanges } from './watch';

// ─── `gesetz check` ───────────────────────────────────────────────────────────

/**
 * Narrowing a run to a category, and re-scoring it against one threshold.
 *
 * The override replaces the configured thresholds for the categories that will
 * actually run, which is why the filter is applied first: `--category strictness
 * --threshold 3` scores strictness against 3 and says nothing about the rest.
 */
/**
 * The files a run was asked about, from however the caller spelled it.
 *
 * Both spellings are accepted and they combine: `--files a.ts,b.ts` and
 * `--files a.ts --files b.ts` are the same request. A path is a glob, so an exact
 * file name is a valid entry. Returns null when nothing was asked for, which
 * means "the whole project" rather than "no files".
 */
export const parseFileRequest = (values: readonly string[]): string[] | null => {
  const globs = values
    .flatMap((value) => value.split(','))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return globs.length > 0 ? globs : null;
};

export const resolveCheckScope = (input: {
  rules: readonly Rule[];
  configuredThresholds: readonly CategoryThreshold[];
  categoryFilter: string | undefined;
  thresholdOverride: number | undefined;
}): { rules: Rule[]; thresholds: CategoryThreshold[] } => {
  const wanted =
    input.categoryFilter === undefined
      ? null
      : new Set(
          input.categoryFilter
            .split(',')
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0),
        );
  const rules =
    wanted === null
      ? [...input.rules]
      : input.rules.filter((rule) => rule.category !== undefined && wanted.has(rule.category));
  const thresholds =
    input.thresholdOverride === undefined
      ? [...input.configuredThresholds]
      : [...new Set(rules.map((rule) => rule.category).filter((c): c is string => c !== undefined))]
          .sort()
          .map((category) => ({ category, minScore: input.thresholdOverride as number }));
  return { rules, thresholds };
};

export const checkCommand = Command.make(
  'check',
  {
    since: Options.text('since').pipe(
      Options.withDescription(
        'Only report violations in files changed since this git ref (e.g. HEAD~5, main)',
      ),
      Options.optional,
    ),
    category: Options.text('category').pipe(
      Options.withDescription('Only run rules in this category (comma-separated)'),
      Options.optional,
    ),
    format: Options.text('format').pipe(
      Options.withDescription(
        'Output format: pretty (default in a TTY), json (agents/CI), ci (GitHub Actions annotations)',
      ),
      Options.optional,
    ),
    all: Options.boolean('all').pipe(
      Options.withDescription('Disable the 50-violation cap in JSON output'),
      Options.withDefault(false),
    ),
    threshold: Options.integer('threshold').pipe(
      Options.withDescription('Minimum passing score per category (0-10). Default: 7'),
      Options.optional,
    ),
    projectRoot: Options.text('project-root').pipe(
      Options.withDescription('Project root directory (default: cwd)'),
      Options.optional,
    ),
    config: Options.text('config').pipe(
      Options.withDescription(
        'Path to gesetz.config.ts (default: <project-root>/gesetz.config.ts)',
      ),
      Options.optional,
    ),
    files: Options.text('files').pipe(
      Options.withDescription(
        'Only check these globs (e.g. "src/a.ts,src/**"). Repeatable, and comma-separated.',
      ),
      Options.repeated,
    ),
    full: Options.boolean('full').pipe(
      Options.withDescription(
        'Bypass the violation cache and re-check everything (no SQLite persistence)',
      ),
      Options.withDefault(false),
    ),
    standalone: Options.boolean('standalone').pipe(
      Options.withDescription(
        'Run immediately: do not wait for, or reuse, another gesetz check in this worktree',
      ),
      Options.withDefault(false),
    ),
    jobs: Options.integer('jobs').pipe(
      Options.withDescription(
        'How many gesetz check runs may proceed at once in this worktree (default 1). GESETZ_JOBS overrides.',
      ),
      Options.withDefault(1),
    ),
    waitTimeout: Options.integer('wait-timeout').pipe(
      Options.withDescription(
        'Seconds to wait for a run in flight before running anyway (default 600)',
      ),
      Options.optional,
    ),
    watch: Options.boolean('watch').pipe(
      Options.withDescription(
        'Re-run checks when files change (incremental via the violation cache)',
      ),
      Options.withDefault(false),
    ),
    baseline: Options.boolean('baseline').pipe(
      Options.withDescription(
        'Report against .gesetz-baseline.json (the default when the file exists)',
      ),
      Options.withDefault(false),
    ),
    noBaseline: Options.boolean('no-baseline').pipe(
      Options.withDescription('Ignore .gesetz-baseline.json and report the full inventory'),
      Options.withDefault(false),
    ),
  },
  (opts) =>
    Effect.gen(function* () {
      const root = nodePath.resolve(Option.getOrElse(opts.projectRoot, () => process.cwd()));
      const changedSince = Option.getOrUndefined(opts.since);
      const configPath = Option.getOrUndefined(opts.config);
      const fileRequest = parseFileRequest(opts.files);
      const config = yield* loadConfig(root, { changedSince, configPath }).pipe(
        Effect.catchTag('ConfigNotFoundError', (e) =>
          Effect.gen(function* () {
            yield* Console.error(e.message);
            return yield* Effect.fail(e);
          }),
        ),
      );

      // Resolves the baseline once per command. `--baseline` demands the file;
      // otherwise an existing file is used automatically.
      let baseline: BaselineFile | null = null;
      if (opts.baseline && opts.noBaseline) {
        yield* Console.error('--baseline and --no-baseline are mutually exclusive.');
        yield* Effect.sync(() => {
          process.exitCode = 1;
        });
        return;
      }
      if (!opts.noBaseline) {
        const loaded = yield* loadBaseline(root).pipe(Effect.either);
        if (loaded._tag === 'Left') {
          yield* Console.error(loaded.left.message);
          yield* Effect.sync(() => {
            process.exitCode = 1;
          });
          return;
        }
        baseline = loaded.right;
        if (baseline === null && opts.baseline) {
          yield* Console.error(
            `No baseline file at ${baselinePathFor(root)}. A maintainer creates it with \`gesetz baseline\`.`,
          );
          yield* Effect.sync(() => {
            process.exitCode = 1;
          });
          return;
        }
      }

      const scope = resolveCheckScope({
        rules: config.rules,
        configuredThresholds: config.thresholds,
        categoryFilter: Option.getOrUndefined(opts.category),
        thresholdOverride: Option.getOrUndefined(opts.threshold),
      });
      const filteredConfig = { ...config, rules: scope.rules };
      const thresholds = scope.thresholds;

      // A gate that silently runs uncached looks identical to a fast machine.
      const storage = resolveStorage(root, opts.full);
      yield* Console.error(describeStorage(storage, RUNTIME));
      const format = detectFormat(Option.getOrUndefined(opts.format) as OutputFormat | undefined);
      const thresholdMap: Record<string, number> = {};
      for (const t of thresholds) thresholdMap[t.category] = t.minScore;

      // ─── Coordination ─────────────────────────────────────────────────────
      //
      // Several agents in one worktree each running the full check is several
      // scans and several runs of every external tool for the same tree. One run
      // answers for all of them when their tree states match.
      const { jobs, standalone, waitTimeoutMs } = resolveCoordinationKnobs({
        flags: {
          standalone: opts.standalone,
          full: opts.full,
          jobs: opts.jobs,
          waitTimeoutSeconds: Option.getOrUndefined(opts.waitTimeout),
        },
        env: process.env,
      });
      const baselineBytes =
        baseline === null ? null : nodeFs.readFileSync(baselinePathFor(root), 'utf8');
      const requestKey = requestKeyFor({
        root,
        configPath,
        rules: filteredConfig.rules,
        thresholds,
        fileFilter: fileRequest,
        changedSince,
        baselineBytes,
        storage,
      });

      let lastScan: { added: number; changed: number; removed: number } | null = null;

      const runAndRender = Effect.gen(function* () {
        const outcome = yield* Effect.promise(() =>
          coordinateRun({
            root,
            requestKey,
            jobs,
            standalone,
            ...(waitTimeoutMs === undefined ? {} : { waitTimeoutMs }),
            recheckedFiles: () => (lastScan === null ? 0 : lastScan.added + lastScan.changed),
            run: () =>
              Effect.runPromise(
                runAll(
                  { ...filteredConfig, thresholds, storage },
                  {
                    baseline,
                    fileFilter: fileRequest,
                    onScan: (scan) => {
                      lastScan = scan;
                      process.stderr.write(
                        `scan: ${scan.filesSeen} files — +${scan.added} ~${scan.changed} -${scan.removed} =${scan.reused} reused (${scan.durationMs}ms)\n`,
                      );
                    },
                  },
                ),
              ),
          }),
        );

        const result = outcome.result;
        const waited = outcome.events.find((event) => event.type === 'waited');
        yield* Console.error(
          describeCoordination({
            mode: outcome.mode,
            waitedMs: outcome.waitedMs,
            runAgeMs: outcome.runAgeMs,
            listeners: outcome.listeners,
            recheckedFiles: outcome.recheckedFiles,
            ...(waited !== undefined && waited.type === 'waited'
              ? { runningPid: waited.runningPid }
              : {}),
          }),
        );

        // Status banner to stderr — stdout stays a clean data contract.
        yield* Console.error(formatStatusBanner(result).trimEnd());

        if (format === 'json') {
          yield* Console.log(
            formatEnvelope(result, {
              all: opts.all,
              thresholds: thresholdMap,
              coordination: {
                mode: outcome.mode,
                waitedMs: outcome.waitedMs,
                runAgeMs: outcome.runAgeMs,
                listeners: outcome.listeners,
                recheckedFiles: outcome.recheckedFiles,
                pid: process.pid,
              },
            }).trimEnd(),
          );
        } else if (format === 'ci') {
          yield* Console.log(formatCi(result).trimEnd());
        } else {
          yield* Console.log(formatCategoryTable(result).trimEnd());
          if (result.totalViolations > 0) {
            yield* Console.log(formatViolations(result.byRule).trimEnd());
          }
        }

        return outcome;
      });

      const first: CoordinationOutcome<RunResult> = yield* runAndRender;
      if (!first.result.passing) {
        yield* Effect.sync(() => {
          process.exitCode = 1;
        });
      }

      if (opts.watch) {
        yield* Console.error('watching for changes… (Ctrl+C to stop)');
        // Each run rebuilds the network, but the marker cache makes re-runs
        // incremental. The watcher ignores the cache directory it writes, so it
        // cannot trigger itself.
        yield* Effect.async<never>((resume) => {
          const watcher = watchForChanges({
            root,
            onSettled: () => {
              Effect.runFork(
                runAndRender.pipe(
                  Effect.catchAllCause((cause) =>
                    Console.error(`watch run failed: ${String(cause)}`),
                  ),
                ),
              );
            },
          });
          process.on('SIGINT', () => {
            watcher.close();
            process.exit(process.exitCode ?? 0);
          });
          void resume;
        });
      }
    }),
).pipe(Command.withDescription('Run all quality rules and show category scores'));

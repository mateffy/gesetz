/**
 * gesetz CLI entry point.
 *
 * Commands:
 *   gesetz check   — run all rules, show category scores
 *   gesetz list    — show rule catalog with guidance
 *   gesetz skill   — print agent skill markdown to stdout
 */
import { pathToFileURL } from 'node:url';
import * as nodeFs from 'node:fs';
import { Command, Options } from '@effect/cli';
import { NodeContext, NodeRuntime } from '@effect/platform-node';
import { Console, Effect, Option } from 'effect';
import * as nodePath from 'node:path';
import {
  defaultCachePath,
  getCacheDriver,
  isNodeSqliteAvailable,
  runAll,
  sqliteUnavailableMessage,
  baselinePathFor,
  type BaselineFile,
  coordinateRun,
  type CoordinationOutcome,
  type RunResult,
} from '@gesetz/core';
import { loadConfig } from './load-config';
import { RUNTIME, resolveStorage } from './storage';
import { baselineCommand, loadBaseline } from './baseline';
import { describeCoordination, requestKeyFor, resolveCoordinationKnobs } from './check-coordination';
import { parseFileRequest, resolveCheckScope } from './check';
import { watchForChanges } from './watch';
import { detectFormat, formatCategoryTable, formatCi, formatExemptionNotices, formatList, formatStatusBanner, formatViolations, type OutputFormat } from './format';
import { formatEnvelope } from './envelope';
import { SKILL_MARKDOWN } from './skill';
import { initCommand } from './init';

/** Debounce for watch-mode re-runs, in milliseconds. */
const WATCH_DEBOUNCE_MS = 150;

// ─── `gesetz check` ───────────────────────────────────────────────────────────

const checkCommand = Command.make(
  'check',
  {
    since: Options.text('since').pipe(
      Options.withDescription('Only report violations in files changed since this git ref (e.g. HEAD~5, main)'),
      Options.optional,
    ),
    category: Options.text('category').pipe(
      Options.withDescription('Only run rules in this category (comma-separated)'),
      Options.optional,
    ),
    format: Options.text('format').pipe(
      Options.withDescription('Output format: pretty (default in a TTY), json (agents/CI), ci (GitHub Actions annotations)'),
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
      Options.withDescription('Path to gesetz.config.ts (default: <project-root>/gesetz.config.ts)'),
      Options.optional,
    ),
    files: Options.text('files').pipe(
      Options.withDescription(
        'Only check these globs (e.g. "src/a.ts,src/**"). Repeatable, and comma-separated. Rules that cannot match are not run.',
      ),
      Options.repeated,
    ),
    full: Options.boolean('full').pipe(
      Options.withDescription('Bypass the violation cache and re-check everything (no SQLite persistence)'),
      Options.withDefault(false),
    ),
    watch: Options.boolean('watch').pipe(
      Options.withDescription('Re-run checks when files change (incremental via the violation cache)'),
      Options.withDefault(false),
    ),
    throwOnError: Options.boolean('throw').pipe(
      Options.withDescription(
        'Fail hard when a rule or tool adapter cannot run, instead of reporting a critical violation',
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
      Options.withDescription('Seconds to wait for a run in flight before running anyway (default 600)'),
      Options.optional,
    ),
    baseline: Options.boolean('baseline').pipe(
      Options.withDescription('Report against .gesetz-baseline.json (the default when the file exists)'),
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
      const config = yield* loadConfig(root, {
        changedSince,
        configPath,
        // An explicit --project-root both locates the config and names the tree
        // to scan, so it must beat the config's own projectRoot.
        projectRootOverride: Option.isSome(opts.projectRoot),
      }).pipe(
        Effect.catchTag('ConfigNotFoundError', (e) =>
          Effect.gen(function* () {
            yield* Console.error(e.message);
            return yield* Effect.fail(e);
          }),
        ),
      );

      const scope = resolveCheckScope({
        rules: config.rules,
        configuredThresholds: config.thresholds,
        categoryFilter: Option.getOrUndefined(opts.category),
        thresholdOverride: Option.getOrUndefined(opts.threshold),
      });
      const filteredConfig = { ...config, rules: scope.rules };
      const thresholds = scope.thresholds;

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

      if (opts.full) {
        yield* Console.error('(--full) cache bypassed — running without persistence.');
      }
      const format = detectFormat(Option.getOrUndefined(opts.format) as OutputFormat | undefined);
      const thresholdMap: Record<string, number> = {};
      for (const t of thresholds) thresholdMap[t.category] = t.minScore;

      // Several agents in one worktree each running the full check is several
      // scans and several runs of every external tool for the same tree. One run
      // answers for all of them when their tree states match.
      const storage = yield* Effect.promise(() =>
        resolveStorage(root, opts.full, filteredConfig.storage),
      );
      yield* Console.error(
        `cache: ${storage.kind === 'sqlite' ? storage.path : 'off'} (runtime: ${RUNTIME})`,
      );

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

      let lastScan: { added: number; changed: number } | null = null;

      const runAndRender: Effect.Effect<CoordinationOutcome<RunResult>> = Effect.gen(function* () {
        const outcome = yield* Effect.promise(() =>
          coordinateRun({
            root,
            requestKey,
            jobs,
            standalone,
            ...(waitTimeoutMs === undefined ? {} : { waitTimeoutMs }),
            recheckedFiles: () =>
              lastScan === null ? 0 : lastScan.added + lastScan.changed,
            run: () =>
              Effect.runPromise(
                runAll(
                  { ...filteredConfig, thresholds, storage },
                  {
                    baseline,
                    fileFilter: fileRequest,
                    throwOnRuleError: opts.throwOnError,
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
        for (const notice of formatExemptionNotices(result)) {
          yield* Console.error(notice);
        }
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

      const first = yield* runAndRender;
      if (!first.result.passing) {
        yield* Effect.sync(() => {
          process.exitCode = 1;
        });
      }

      if (opts.watch) {
        yield* Console.error('watching for changes… (Ctrl+C to stop)');
        // fs.watch + debounce + re-run runAll: each run is a fresh network,
        // but the SQLite marker cache makes re-runs incremental. Events
        // under the cache dir and VCS/dependency dirs are ignored so the
        // watcher cannot trigger itself.
        yield* Effect.async<never>((resume) => {
          let timer: NodeJS.Timeout | undefined;
          const IGNORED = /(\/|^)(\.gesetz|\.git|node_modules)(\/|$)/;
          const watcher = nodeFs.watch(root, { recursive: true }, (_event, filename) => {
            if (filename === null || IGNORED.test(filename)) return;
            if (timer !== undefined) clearTimeout(timer);
            timer = setTimeout(() => {
              Effect.runFork(
                runAndRender.pipe(
                  Effect.catchAllCause((cause) =>
                    Console.error(`watch run failed: ${String(cause)}`),
                  ),
                ),
              );
            }, WATCH_DEBOUNCE_MS);
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

// ─── `gesetz list` ────────────────────────────────────────────────────────────

const listCommand = Command.make(
  'list',
  {
    category: Options.text('category').pipe(
      Options.withDescription('Filter by category (comma-separated)'),
      Options.optional,
    ),
    format: Options.text('format').pipe(
      Options.withDescription('Output format: pretty (default in a TTY) or json'),
      Options.optional,
    ),
    projectRoot: Options.text('project-root').pipe(
      Options.withDescription('Project root directory (default: cwd)'),
      Options.optional,
    ),
  },
  (opts) =>
    Effect.gen(function* () {
      const root = nodePath.resolve(Option.getOrElse(opts.projectRoot, () => process.cwd()));
      const categoryFilter = Option.map(
        opts.category,
        (v) => new Set(v.split(',').map((s) => s.trim())),
      );

      const config = yield* loadConfig(root).pipe(
        Effect.catchTag('ConfigNotFoundError', (e) =>
          Effect.gen(function* () {
            yield* Console.error(e.message);
            return yield* Effect.fail(e);
          }),
        ),
      );

      const entries = config.rules
        .filter(
          (r) =>
            Option.isNone(categoryFilter) ||
            (r.category !== undefined && categoryFilter.value.has(r.category)),
        )
        .map((r) => ({
          id: r.id,
          description: r.description,
          category: r.category,
          guidance: r.guidance,
        }));

      const format = detectFormat(Option.getOrUndefined(opts.format) as OutputFormat | undefined);
      yield* Console.log(formatList(entries, format).trimEnd());
    }),
).pipe(Command.withDescription('List all quality rules with guidance'));

// ─── `gesetz skill` ───────────────────────────────────────────────────────────

const skillCommand = Command.make(
  'skill',
  {},
  () => Console.log(SKILL_MARKDOWN),
).pipe(Command.withDescription('Print agent skill markdown to stdout'));

// ─── Root command ─────────────────────────────────────────────────────────────

const gesetzCommand = Command.make('gesetz', {}, () =>
  Console.log('Run `gesetz --help` to see available commands.'),
).pipe(
  Command.withDescription('Unified code quality gate \u2014 Gesetz v0.1.0'),
  Command.withSubcommands([checkCommand, baselineCommand, listCommand, skillCommand, initCommand]),
);

// ─── Entry point ─────────────────────────────────────────────────────────────

const cli = Command.run(gesetzCommand, {
  name: 'Gesetz',
  version: 'v0.1.0',
});

export function runGesetz(): void {
  NodeRuntime.runMain(cli(process.argv).pipe(Effect.provide(NodeContext.layer)));
}

// Detect whether this module is the process entry point. We must resolve
// symlinks (npm/pnpm install the bin as a symlink in node_modules/.bin/
// pointing at dist/main.js), otherwise process.argv[1] is the symlink path
// while import.meta.url is the real file URL and the comparison fails —
// silently making the CLI produce no output and exit 0.
const entryArg = process.argv[1] ?? '';
const isEntryPoint =
  entryArg.length > 0 &&
  import.meta.url === pathToFileURL(nodeFs.realpathSync(entryArg)).href;
if (isEntryPoint) {
  runGesetz();
}

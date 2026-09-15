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
} from '@gesetz/core';
import { loadConfig } from './load-config';
import {
  formatCategoryTable,
  formatViolations,
  formatEnvelope,
  formatCi,
  formatStatusBanner,
  formatList,
  detectFormat,
  type OutputFormat,
} from './format';
import { SKILL_MARKDOWN } from './skill';
import { initCommand } from './init';

// ─── Storage resolution ─────────────────────────────────────────────────────

/** Guards the one-time notices so watch mode does not repeat them. */
let storageNoticeShown = false;

function noticeOnce(message: string): void {
  if (storageNoticeShown) return;
  storageNoticeShown = true;
  process.stderr.write(`(cache) ${message}\n`);
}

/** Creates `dir` when needed, and reports whether it is writable. */
function ensureWritableDir(dir: string): boolean {
  try {
    nodeFs.mkdirSync(dir, { recursive: true });
    nodeFs.accessSync(dir, nodeFs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves where this run caches its results.
 *
 * Precedence (highest first):
 *   1. `--full` or `GESETZ_DB=off`        → nothing is persisted
 *   2. `storage: { kind: 'memory' }` in gesetz.config.ts → nothing is persisted
 *   3. `GESETZ_DB=<path>`                 → that path
 *   4. `storage: { kind: 'sqlite', path }` in gesetz.config.ts → that path
 *   5. otherwise                          → the shared cache (`~/.cache/gesetz/cache.db`)
 *   6. shared location unusable           → `<root>/.gesetz/cache.db`
 *
 * The shared cache keeps every project's entries in one file, namespaced by
 * project root, so there is nothing to gitignore and one place to clear. Nothing
 * is shared *between* projects: entries are keyed by repo-relative path and some
 * checks read other files, so cross-project reuse would be wrong.
 *
 * Persistence needs a SQLite driver: the built-in `node:sqlite` module, or one
 * registered by an optional compat package imported from `gesetz.config.ts`.
 * Without either, the run continues in memory and explains how to enable it.
 */
const resolveStorage = async (
  root: string,
  full: boolean,
  configured: import('@gesetz/core').GesetzStorageConfig | undefined,
): Promise<import('@gesetz/core').GesetzStorageConfig> => {
  if (full) return { kind: 'memory' };
  const override = process.env['GESETZ_DB'];
  if (override === 'off') return { kind: 'memory' };
  if (configured?.kind === 'memory') return { kind: 'memory' };

  if (!(await isNodeSqliteAvailable()) && getCacheDriver('sqlite') === undefined) {
    noticeOnce(sqliteUnavailableMessage());
    return { kind: 'memory' };
  }

  // 1. An explicit path — from the environment or the config — wins outright.
  const explicit = override ?? (configured?.kind === 'sqlite' ? configured.path : undefined);
  if (explicit !== undefined) {
    if (ensureWritableDir(nodePath.dirname(explicit))) return { kind: 'sqlite', path: explicit };
    noticeOnce(`cannot write to ${explicit} — running without a persistent cache.`);
    return { kind: 'memory' };
  }

  // 2. The shared, cross-project cache.
  const shared = defaultCachePath();
  if (ensureWritableDir(nodePath.dirname(shared))) return { kind: 'sqlite', path: shared };

  // 3. Project-local fallback when the shared location is unusable
  //    (read-only HOME, containers, restricted CI runners).
  const local = nodePath.join(root, '.gesetz', 'cache.db');
  if (ensureWritableDir(nodePath.dirname(local))) return { kind: 'sqlite', path: local };

  noticeOnce(`cannot write a cache file — running without a persistent cache.`);
  return { kind: 'memory' };
};

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
      Options.withDescription('Only check files matching these comma-separated globs (e.g. "src/components/**")'),
      Options.optional,
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
  },
  (opts) =>
    Effect.gen(function* () {
      const root = nodePath.resolve(Option.getOrElse(opts.projectRoot, () => process.cwd()));
      const changedSince = Option.getOrUndefined(opts.since);
      const configPath = Option.getOrUndefined(opts.config);
      const filesGlobs = Option.map(opts.files, (v) =>
        v.split(',').map((s) => s.trim()).filter(Boolean),
      );
      const categoryFilter = Option.map(
        opts.category,
        (v) => new Set(v.split(',').map((s) => s.trim())),
      );

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

      // Apply category filter
      const filteredConfig = Option.isSome(categoryFilter)
        ? {
            ...config,
            rules: config.rules.filter(
              (r) => r.category !== undefined && categoryFilter.value.has(r.category),
            ),
          }
        : config;

      // Apply threshold override
      const thresholds = Option.match(opts.threshold, {
        onNone: () => filteredConfig.thresholds,
        onSome: (t) =>
          [...new Set(filteredConfig.rules.map((r) => r.category).filter(Boolean) as string[])].map(
            (cat) => ({ category: cat, minScore: t }),
          ),
      });

      if (opts.full) {
        yield* Console.error('(--full) cache bypassed — running without persistence.');
      }
      const format = detectFormat(Option.getOrUndefined(opts.format) as OutputFormat | undefined);
      const thresholdMap: Record<string, number> = {};
      for (const t of thresholds) thresholdMap[t.category] = t.minScore;

      const runAndRender = Effect.gen(function* () {
        const storage = yield* Effect.promise(() =>
          resolveStorage(root, opts.full, filteredConfig.storage),
        );
        const result = yield* runAll(
          { ...filteredConfig, thresholds, storage },
          {
            fileFilter: Option.getOrUndefined(filesGlobs) ?? null,
            throwOnRuleError: opts.throwOnError,
            onScan: (scan) => {
              process.stderr.write(
                `scan: ${scan.filesSeen} files — +${scan.added} ~${scan.changed} -${scan.removed} =${scan.reused} reused (${scan.durationMs}ms)\n`,
              );
            },
          },
        );

        // Status banner to stderr — stdout stays a clean data contract.
        yield* Console.error(formatStatusBanner(result).trimEnd());

        if (format === 'json') {
          yield* Console.log(formatEnvelope(result, { all: opts.all, thresholds: thresholdMap }).trimEnd());
        } else if (format === 'ci') {
          yield* Console.log(formatCi(result).trimEnd());
        } else {
          yield* Console.log(formatCategoryTable(result).trimEnd());
          if (result.totalViolations > 0) {
            yield* Console.log(formatViolations(result.byRule).trimEnd());
          }
        }

        return result;
      });

      const first = yield* runAndRender;
      if (!first.passing) {
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
            }, 150);
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
  Command.withSubcommands([checkCommand, listCommand, skillCommand, initCommand]),
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

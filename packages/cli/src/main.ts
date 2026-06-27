#!/usr/bin/env bun
/**
 * regel CLI entry point.
 *
 * Commands:
 *   regel check   — run all rules, show category scores
 *   regel list    — show rule catalog with guidance
 *   regel skill   — print agent skill markdown to stdout
 */
import { pathToFileURL } from 'node:url';
import { Command, Options } from '@effect/cli';
import { NodeContext, NodeRuntime } from '@effect/platform-node';
import { Console, Effect, Layer, Option } from 'effect';
import * as nodePath from 'node:path';
import { runAll, FileSystemLive, PhpAdapterStub, ProjectRootLive, FileFilterLive } from '@regeln/core';
import { TsAdapterLive } from '@regeln/typescript';
import { PhpAdapterLive } from '@regeln/php';
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

// ─── Shared services layer ────────────────────────────────────────────────────

const makeServicesLayer = (root: string, fileGlobs?: readonly string[] | undefined) =>
  Layer.mergeAll(
    FileSystemLive,
    TsAdapterLive,
    PhpAdapterLive,
    ProjectRootLive(root),
    FileFilterLive(fileGlobs ?? null),
  );

// ─── `regel check` ───────────────────────────────────────────────────────────

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
      Options.withDescription('Path to regel.config.ts (default: <project-root>/regel.config.ts)'),
      Options.optional,
    ),
    files: Options.text('files').pipe(
      Options.withDescription('Only check files matching these comma-separated globs (e.g. "src/components/**")'),
      Options.optional,
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

      const config = yield* loadConfig(
        root,
        { changedSince, configPath },
      ).pipe(
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

      const result = yield* runAll({ ...filteredConfig, thresholds }).pipe(
        Effect.provide(makeServicesLayer(root, Option.getOrUndefined(filesGlobs))),
        Effect.catchAllCause((cause) =>
          Effect.gen(function* () {
            yield* Console.error(`regel check failed: ${String(cause)}`);
            return yield* Effect.fail(new Error(String(cause)));
          }),
        ),
      );

      const format = detectFormat(Option.getOrUndefined(opts.format) as OutputFormat | undefined);
      const thresholdMap: Record<string, number> = {};
      for (const t of thresholds) thresholdMap[t.category] = t.minScore;

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

      if (!result.passing) {
        yield* Effect.fail(new Error('One or more categories below threshold'));
      }
    }),
).pipe(Command.withDescription('Run all quality rules and show category scores'));

// ─── `regel list` ────────────────────────────────────────────────────────────

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

// ─── `regel skill` ───────────────────────────────────────────────────────────

const skillCommand = Command.make(
  'skill',
  {},
  () => Console.log(SKILL_MARKDOWN),
).pipe(Command.withDescription('Print agent skill markdown to stdout'));

// ─── Root command ─────────────────────────────────────────────────────────────

const regelCommand = Command.make('regel', {}, () =>
  Console.log('Run `regel --help` to see available commands.'),
).pipe(
  Command.withDescription('Unified code quality gate \u2014 Regel v0.1.0'),
  Command.withSubcommands([checkCommand, listCommand, skillCommand, initCommand]),
);

// ─── Entry point ─────────────────────────────────────────────────────────────

const cli = Command.run(regelCommand, {
  name: 'Regel',
  version: 'v0.1.0',
});

export function runRegel(): void {
  NodeRuntime.runMain(cli(process.argv).pipe(Effect.provide(NodeContext.layer)));
}

const isEntryPoint = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isEntryPoint) {
  runRegel();
}

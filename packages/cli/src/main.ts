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
import { loadConfig } from './load-config';
import { baselineCommand } from './baseline';
import { checkCommand } from './check';
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

const skillCommand = Command.make('skill', {}, () => Console.log(SKILL_MARKDOWN)).pipe(
  Command.withDescription('Print agent skill markdown to stdout'),
);

// ─── Root command ─────────────────────────────────────────────────────────────

const gesetzCommand = Command.make('gesetz', {}, () =>
  Console.log('Run `gesetz --help` to see available commands.'),
).pipe(
  Command.withDescription('Unified code quality gate \u2014 Gesetz v0.1.0'),
  Command.withSubcommands([checkCommand, listCommand, skillCommand, baselineCommand, initCommand]),
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
  entryArg.length > 0 && import.meta.url === pathToFileURL(nodeFs.realpathSync(entryArg)).href;
if (isEntryPoint) {
  runGesetz();
}

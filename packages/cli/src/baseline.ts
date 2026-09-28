/**
 * `gesetz baseline` — write or inspect `.gesetz-baseline.json`.
 *
 * Writing the baseline is a maintainer action. An agent batch must not absorb
 * its own regression, so the project can set `baseline.readOnly` in
 * gesetz.config.ts to make the write refuse entirely.
 *
 * The write itself refuses when a violation is not in the existing baseline.
 * `--rule <id>` is the explicit accept for the day a new rule lands: it
 * re-baselines exactly the named rules and leaves every other entry untouched.
 */
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { Command, Options } from '@effect/cli';
import { Console, Effect, Option } from 'effect';
import {
  BASELINE_FILE_NAME,
  BaselineFileError,
  baselinePathFor,
  buildBaselineFile,
  planBaselineWrite,
  readBaselineFile,
  runAll,
  writeBaselineFile,
  type BaselineFile,
  type BaselineWritePlan,
} from '@gesetz/core';
import { loadConfig } from './load-config';

/** Most refusals printed before the list is summarised. */
const REFUSAL_PRINT_CAP = 25;

/** Version of the running CLI, for the baseline header. Informational. */
function gesetzVersion(): string {
  try {
    const text = nodeFs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8');
    const parsed: unknown = JSON.parse(text) as unknown;
    if (typeof parsed === 'object' && parsed !== null && 'version' in parsed) {
      const version = (parsed as { version: unknown }).version;
      if (typeof version === 'string') return version;
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Loads the baseline file, turning any read failure into a tagged error. */
export function loadBaseline(root: string): Effect.Effect<BaselineFile | null, BaselineFileError> {
  const path = baselinePathFor(root);
  return Effect.try({
    try: () => readBaselineFile(path),
    catch: (cause) =>
      cause instanceof BaselineFileError
        ? cause
        : new BaselineFileError({ path, message: `Could not read ${path}: ${String(cause)}` }),
  });
}

/** Widest rule-name column in the delta table, so long ids cannot push it off. */
const MAX_RULE_NAME_WIDTH = 60;

/** Human-readable delta, per rule: what the write adds, drops and keeps. */
function formatPlan(plan: BaselineWritePlan, wrote: boolean, path: string): string {
  const header = wrote
    ? `gesetz baseline: wrote ${BASELINE_FILE_NAME} (${plan.next.total} entries; ${plan.added} added, ${plan.removed} removed, ${plan.kept} kept)`
    : `gesetz baseline: dry run against ${path} (${plan.next.total} entries; ${plan.added} added, ${plan.removed} removed, ${plan.kept} kept)`;
  const width = Math.min(
    MAX_RULE_NAME_WIDTH,
    plan.deltas.reduce((max, delta) => Math.max(max, delta.rule.length), 0),
  );
  const lines = plan.deltas.map(
    (delta) =>
      `  ${delta.rule.padEnd(width)}  +${delta.added}  -${delta.removed}  kept ${delta.kept}`,
  );
  return [header, ...lines].join('\n');
}

function formatRefusals(plan: BaselineWritePlan): string {
  const lines = [
    `gesetz baseline: refused — ${plan.refused.length} violation(s) are not in the baseline:`,
  ];
  for (const refusal of plan.refused.slice(0, REFUSAL_PRINT_CAP)) {
    const location = refusal.path + (refusal.count > 1 ? ` (x${refusal.count})` : '');
    lines.push(`  ${refusal.rule}  ${location}`);
  }
  if (plan.refused.length > REFUSAL_PRINT_CAP) {
    lines.push(`  ... and ${plan.refused.length - REFUSAL_PRINT_CAP} more`);
  }
  lines.push('Fix them, or accept one rule explicitly with `gesetz baseline --rule <rule-id>`.');
  return lines.join('\n');
}

/** Splits the `--rule` flag into ids and rejects ids the config does not define. */
function parseRuleFilter(
  raw: string | undefined,
  configRuleIds: readonly string[],
): { ids: string[] | undefined; unknown: string[] } {
  if (raw === undefined) return { ids: undefined, unknown: [] };
  const ids = raw
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const known = new Set(configRuleIds);
  return { ids, unknown: ids.filter((id) => !known.has(id)) };
}

const projectRootOption = Options.text('project-root').pipe(
  Options.withDescription('Project root directory (default: cwd)'),
  Options.optional,
);
const configOption = Options.text('config').pipe(
  Options.withDescription('Path to gesetz.config.ts (default: <project-root>/gesetz.config.ts)'),
  Options.optional,
);

export const baselineCommand = Command.make(
  'baseline',
  {
    dryRun: Options.boolean('dry-run').pipe(
      Options.withDescription('Show the delta and write nothing'),
      Options.withDefault(false),
    ),
    rule: Options.text('rule').pipe(
      Options.withDescription(
        'Re-baseline only these rules (comma-separated) — the explicit accept for a new rule',
      ),
      Options.optional,
    ),
    since: Options.text('since').pipe(
      Options.withDescription(
        'Only consider files changed since this git ref (default: the full inventory)',
      ),
      Options.optional,
    ),
    projectRoot: projectRootOption,
    config: configOption,
  },
  (opts) =>
    Effect.gen(function* () {
      const root = nodePath.resolve(Option.getOrElse(opts.projectRoot, () => process.cwd()));
      const config = yield* loadConfig(root, {
        configPath: Option.getOrUndefined(opts.config),
      });
      const path = baselinePathFor(root);

      if (config.baseline.readOnly === true) {
        yield* Console.error(
          `gesetz baseline: refused — gesetz.config.ts sets baseline.readOnly.\n` +
            `Re-baselining is a maintainer action. Flip the flag in a reviewed change.`,
        );
        yield* Effect.sync(() => {
          process.exitCode = 1;
        });
        return;
      }

      const ruleFilter = parseRuleFilter(
        Option.getOrUndefined(opts.rule),
        config.rules.map((rule) => rule.id),
      );
      if (ruleFilter.unknown.length > 0) {
        yield* Console.error(
          `gesetz baseline: unknown rule id(s): ${ruleFilter.unknown.join(', ')}. ` +
            `Run \`gesetz list\` to see the configured rules.`,
        );
        yield* Effect.sync(() => {
          process.exitCode = 1;
        });
        return;
      }

      // A baseline command defaults to the full inventory; `--since` is an
      // explicit partial run.
      const result = yield* runAll(
        { ...config, changedSince: Option.getOrUndefined(opts.since) },
        {},
      );
      const version = gesetzVersion();
      const modes = new Map(
        config.rules.map((rule) => [rule.id, rule.baselineMessage ?? 'normalized'] as const),
      );
      const current = buildBaselineFile(
        result.byRule.map((rule) => ({ rule: rule.ruleId, violations: rule.violations })),
        { gesetzVersion: version, modes },
      );
      const loaded = yield* loadBaseline(root).pipe(Effect.either);
      if (loaded._tag === 'Left') {
        yield* Console.error(loaded.left.message);
        yield* Effect.sync(() => {
          process.exitCode = 1;
        });
        return;
      }
      const existing = loaded.right;
      const plan = planBaselineWrite(current, existing, {
        rules: ruleFilter.ids,
        gesetzVersion: version,
      });

      if (plan.refused.length > 0) {
        yield* Console.error(formatRefusals(plan));
        yield* Console.error(formatPlan(plan, false, path));
        yield* Effect.sync(() => {
          process.exitCode = 1;
        });
        return;
      }

      if (!opts.dryRun) {
        yield* Effect.sync(() => writeBaselineFile(path, plan.next));
      }
      yield* Console.log(formatPlan(plan, !opts.dryRun, path));
    }),
).pipe(
  Command.withDescription(
    'Write .gesetz-baseline.json — maintainer action, refuses new violations',
  ),
);

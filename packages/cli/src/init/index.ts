/**
 * `regel init` command.
 *
 * Interactive when stdout is a TTY and no agent env var is set; otherwise
 * non-interactive (flags + auto-detection). Emits a JSON receipt on
 * `--format=json` (or auto-detected agent env), else a pretty summary.
 */
import { Command, Options } from '@effect/cli';
import { Console, Effect, Option } from 'effect';
import * as nodePath from 'node:path';
import { detectProject, type ProjectProfile } from './detect';
import { resolvePlanFromFlags, writeConfig, type WriteResult, type InitFlags } from './write';
import { runWizard } from './prompt';
import { AGENT_ENV_VARS, detectFormat, type OutputFormat } from '../format';

// ─── Receipt / summary ───────────────────────────────────────────────────────

interface Receipt {
  v: 1;
  command: 'init';
  status: 'ok' | 'error';
  preset?: string;
  tools?: string[];
  rules?: string[];
  configPath?: string;
  installed?: string[];
  qaScript?: boolean;
  pm?: string;
  error?: string;
}

const emitReceipt = (r: Receipt): Effect.Effect<void> =>
  Console.log(JSON.stringify(r));

function emitPretty(
  res: WriteResult,
  plan: ReturnType<typeof resolvePlanFromFlags>,
): Effect.Effect<void> {
  const lines = [
    `\u2713 Created ${nodePath.relative(plan.profile.cwd, res.configPath)}`,
    `  Preset: ${plan.preset}`,
    `  Tools: ${[...plan.tools].join(', ') || '(none)'}`,
    `  Rules: ${plan.rules.size}`,
  ];
  if (res.installed.length > 0) {
    lines.push(`  Installed (${res.pm}): ${res.installed.join(', ')}`);
  }
  if (res.qaScript) {
    lines.push(`  Added "qa" script to ${res.pm === 'composer' ? 'composer.json' : 'package.json'}`);
  }
  lines.push('', 'Next: run `regel check`');
  return Console.log(lines.join('\n'));
}

// ─── Command ─────────────────────────────────────────────────────────────────

function isInteractive(): boolean {
  if (process.stdout.isTTY !== true) return false;
  if (AGENT_ENV_VARS.some((k) => process.env[k])) return false;
  return true;
}

export const initCommand = Command.make(
  'init',
  {
    preset: Options.text('preset').pipe(
      Options.withDescription('Preset: blank | generic | react | tanstack-start | laravel'),
      Options.optional,
    ),
    tools: Options.text('tools').pipe(
      Options.withDescription('Comma-separated QA tools to wire in (e.g. oxlint,vitest)'),
      Options.optional,
    ),
    rules: Options.text('rules').pipe(
      Options.withDescription('Comma-separated blueprint ids to include (overrides preset defaults)'),
      Options.optional,
    ),
    force: Options.boolean('force').pipe(
      Options.withDescription('Overwrite an existing regel.config.ts'),
      Options.withDefault(false),
    ),
    noInstall: Options.boolean('no-install').pipe(
      Options.withDescription('Skip installing @regeln/* packages'),
      Options.withDefault(false),
    ),
    noQaScript: Options.boolean('no-qa-script').pipe(
      Options.withDescription('Skip adding a "qa" script to package.json'),
      Options.withDefault(false),
    ),
    pm: Options.text('pm').pipe(
      Options.withDescription('Package manager override: bun | pnpm | npm | yarn (composer for Laravel)'),
      Options.optional,
    ),
    interactive: Options.boolean('interactive').pipe(
      Options.withDescription('Force interactive mode even when not a TTY'),
      Options.withDefault(false),
    ),
    noInteractive: Options.boolean('no-interactive').pipe(
      Options.withDescription('Force non-interactive mode (auto-detect + flags)'),
      Options.withDefault(false),
    ),
    format: Options.text('format').pipe(
      Options.withDescription('Output format: pretty (default) or json (receipt)'),
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
      const fmt = detectFormat(Option.getOrUndefined(opts.format) as OutputFormat | undefined);

      const profile: ProjectProfile = detectProject(root);

      const flags: InitFlags = {
        preset: Option.getOrUndefined(opts.preset),
        tools: Option.getOrUndefined(opts.tools),
        rules: Option.getOrUndefined(opts.rules),
        force: opts.force,
        install: !opts.noInstall,
        qaScript: !opts.noQaScript,
        pm: Option.getOrUndefined(opts.pm),
        interactive: opts.interactive && !opts.noInteractive,
      };

      const useInteractive = !opts.noInteractive && (opts.interactive || isInteractive());

      // Build the plan.
      let plan;
      if (useInteractive) {
        plan = yield* runWizard(profile, flags).pipe(
          Effect.catchAll((e: unknown) => {
            if (e instanceof Error && '_tag' in e && e._tag === 'QuitException') {
              return Effect.gen(function* () {
                yield* Console.error('regel init cancelled');
                return undefined;
              });
            }
            const message = e instanceof Error ? e.message : String(e);
            return Effect.gen(function* () {
              yield* Console.error(`regel init failed: ${message}`);
              return yield* Effect.fail(new Error(message));
            });
          }),
        );
      } else {
        plan = resolvePlanFromFlags(profile, flags);
      }

      if (plan === undefined) {
        return yield* Effect.succeed(undefined);
      }

      // Write.
      const result = yield* writeConfig(plan, flags).pipe(
        Effect.catchAll((e: unknown) =>
          Effect.gen(function* () {
            const message = e instanceof Error ? e.message : String(e);
            if (fmt === 'json') {
              yield* emitReceipt({ v: 1, command: 'init', status: 'error', error: message });
            } else {
              yield* Console.error(`regel init failed: ${message}`);
            }
            return yield* Effect.fail(new Error(message));
          }),
        ),
      );

      // Emit summary.
      if (fmt === 'json') {
        yield* emitReceipt({
          v: 1,
          command: 'init',
          status: 'ok',
          preset: plan.preset,
          tools: [...plan.tools],
          rules: [...plan.rules],
          configPath: nodePath.relative(root, result.configPath),
          installed: result.installed,
          qaScript: result.qaScript,
          pm: result.pm,
        });
      } else {
        yield* emitPretty(result, plan);
      }
    }),
).pipe(Command.withDescription('Initialize a new regel.config.ts in the current project'));

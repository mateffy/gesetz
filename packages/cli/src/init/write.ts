/**
 * Non-interactive plan resolver + config writer.
 *
 * `resolvePlanFromFlags` is pure — for each omitted flag it falls back to
 * auto-detection. `writeConfig` performs the file write, optional `qa` script
 * injection, and optional dependency install.
 */
import * as nodePath from 'node:path';
import * as nodeFs from 'node:fs';
import { Effect, Console } from 'effect';
import { FileSystem } from '@effect/platform';
import { Command } from '@effect/platform';
import { CommandExecutor } from '@effect/platform';
import type { ProjectProfile, ToolId, PackageManager } from './detect';
import type { Plan } from './rules';
import { generateConfig } from './rules';
import { getBlueprint, toolsForPreset, blueprintsForPreset } from './rules';

// ─── Flag shape (what the CLI passes in) ──────────────────────────────────────

export interface InitFlags {
  readonly preset?: string | undefined;
  readonly tools?: string | undefined; // comma-separated ToolIds
  readonly rules?: string | undefined; // comma-separated blueprint ids
  readonly force: boolean;
  readonly install: boolean; // true unless --no-install
  readonly qaScript: boolean; // true unless --no-qa-script
  readonly pm?: string | undefined; // override package manager
  readonly interactive: boolean;
}

// ─── Resolver ─────────────────────────────────────────────────────────────────

function parseList(s: string | undefined): string[] | undefined {
  if (!s) return undefined;
  const parts = s.split(',').map((x) => x.trim()).filter(Boolean);
  return parts.length ? parts : undefined;
}

/**
 * Build a Plan from flags + detected profile. For each omitted flag, fall back
 * to detection-derived defaults.
 */
export function resolvePlanFromFlags(profile: ProjectProfile, flags: InitFlags): Plan {
  const preset = (flags.preset ?? profile.suggestedPreset) as Plan['preset'];

  // Tools: explicit > detected (filtered by preset relevance).
  const toolList = parseList(flags.tools);
  let tools: Set<ToolId>;
  if (toolList) {
    tools = new Set(toolList as ToolId[]);
  } else {
    const detected = new Set(profile.detectedTools.map((t) => t.tool));
    const suggested = new Set(toolsForPreset(preset));
    tools = new Set([...detected].filter((t) => suggested.has(t) || suggested.size === 0));
    if (tools.size === 0) tools = new Set(profile.detectedTools.map((t) => t.tool));
  }

  // Rules: explicit > preset defaults ∪ tool-derived.
  const ruleList = parseList(flags.rules);
  let rules: Set<string>;
  if (ruleList) {
    rules = new Set(ruleList);
  } else {
    rules = new Set(blueprintsForPreset(preset).map((b) => b.id));
  }

  return {
    preset,
    tools,
    rules,
    install: flags.install,
    qaScript: flags.qaScript,
    profile: { ...profile, packageManager: resolvePm(profile, flags) },
  };
}

function resolvePm(profile: ProjectProfile, flags: InitFlags): PackageManager {
  if (flags.pm) return flags.pm as PackageManager;
  return profile.packageManager;
}

// ─── Write ────────────────────────────────────────────────────────────────────

export interface WriteResult {
  readonly configPath: string;
  readonly installed: string[];
  readonly qaScript: boolean;
  readonly pm: PackageManager;
}

const CONFIG_PATH = 'regel.config.ts';

const INSTALL_PACKAGES: Record<PackageManager, (pkg: string) => string[]> = {
  bun: (p) => ['bun', 'add', ...p.split(' ')],
  pnpm: (p) => ['pnpm', 'add', ...p.split(' ')],
  npm: (p) => ['npm', 'install', ...p.split(' ')],
  yarn: (p) => ['yarn', 'add', ...p.split(' ')],
  composer: (p) => ['composer', 'require', ...p.split(' ')],
};

/** The @regeln packages to install for a plan. */
function packagesForPlan(plan: Plan): string[] {
  const pkgs = new Set<string>(['@regeln/core']);
  if (plan.preset === 'laravel') {
    pkgs.add('@regeln/laravel');
    pkgs.add('@regeln/php');
  } else {
    pkgs.add('@regeln/typescript');
  }
  for (const tool of plan.tools) {
    const map: Record<ToolId, string> = {
      oxlint: '@regeln/oxlint',
      oxfmt: '@regeln/oxfmt',
      prettier: '@regeln/prettier',
      eslint: '@regeln/eslint',
      vitest: '@regeln/vitest',
      'bun-test': '@regeln/bun-test',
      storybook: '@regeln/storybook',
      phpstan: '@regeln/phpstan',
      pest: '@regeln/pest',
      phpunit: '@regeln/phpunit',
    };
    pkgs.add(map[tool]);
  }
  return [...pkgs];
}

/** Idempotently add a `qa` script to package.json or composer.json. */
function writeQaScriptEffect(
  cwd: string,
  pm: PackageManager,
): Effect.Effect<void, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    if (pm === 'composer') {
      const path = nodePath.join(cwd, 'composer.json');
      const exists = yield* fs.exists(path).pipe(Effect.catchAll(() => Effect.succeed(false)));
      if (!exists) return;
      const txt = yield* fs.readFileString(path).pipe(
        Effect.catchAll(() => Effect.succeed('')),
      );
      if (!txt) return;
      const json = JSON.parse(txt) as { scripts?: Record<string, string> };
      if (!json.scripts) json.scripts = {};
      if (json.scripts.qa) return;
      json.scripts.qa = 'regel check';
      yield* fs.writeFileString(path, JSON.stringify(json, null, 4) + '\n').pipe(
        Effect.catchAll((e) => Console.error(`Could not write qa script: ${String(e)}`)),
      );
      return;
    }

    const path = nodePath.join(cwd, 'package.json');
    const exists = yield* fs.exists(path).pipe(Effect.catchAll(() => Effect.succeed(false)));
    if (!exists) return;
    const txt = yield* fs.readFileString(path).pipe(
      Effect.catchAll(() => Effect.succeed('')),
    );
    if (!txt) return;
    const json = JSON.parse(txt) as { scripts?: Record<string, string> };
    if (!json.scripts) json.scripts = {};
    if (json.scripts.qa) return;
    json.scripts.qa = 'regel check';
    yield* fs.writeFileString(path, JSON.stringify(json, null, 2) + '\n').pipe(
      Effect.catchAll((e) => Console.error(`Could not write qa script: ${String(e)}`)),
    );
  });
}

/**
 * Write the config file (refusing overwrite unless `--force`), optionally
 * add the `qa` script, and optionally install packages.
 *
 * Requires `FileSystem` and `CommandExecutor` in the environment.
 * The CLI entry point provides these via `NodeContext.layer`.
 */
export function writeConfig(
  plan: Plan,
  flags: InitFlags,
): Effect.Effect<WriteResult, Error, FileSystem.FileSystem | CommandExecutor.CommandExecutor> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = plan.profile.cwd;
    const configPath = nodePath.join(cwd, CONFIG_PATH);

    if (plan.profile.hasExistingConfig && !flags.force) {
      return yield* Effect.fail(
        new Error(`${CONFIG_PATH} already exists — use --force to overwrite`),
      );
    }

    const src = generateConfig(plan);
    yield* fs.writeFileString(configPath, src).pipe(
      Effect.catchAll((e) =>
        Effect.fail(new Error(`Failed to write ${configPath}: ${String(e)}`)),
      ),
    );

    let installed: string[] = [];
    if (plan.install) {
      const pkgs = packagesForPlan(plan);
      const cmd = INSTALL_PACKAGES[plan.profile.packageManager](pkgs.join(' '));
      const [bin, ...args] = cmd;
      if (!bin) {
        return { configPath, installed: [], qaScript: plan.qaScript, pm: plan.profile.packageManager };
      }
      const command = Command.make(bin, ...args).pipe(
        Command.workingDirectory(cwd),
        Command.stdout('inherit'),
        Command.stderr('inherit'),
      );
      const exitCode = yield* Command.exitCode(command).pipe(
        Effect.catchAll((cause) =>
          Effect.gen(function* () {
            yield* Effect.logWarning(`Install failed: ${String(cause)}`);
            return -1;
          }),
        ),
      );
      if (exitCode === 0) {
        installed = pkgs;
      }
    }

    if (plan.qaScript) {
      yield* writeQaScriptEffect(cwd, plan.profile.packageManager).pipe(
        Effect.catchAll((e) => Effect.logWarning(`Could not write qa script: ${String(e)}`)),
      );
    }

    return {
      configPath,
      installed,
      qaScript: plan.qaScript,
      pm: plan.profile.packageManager,
    };
  });
}

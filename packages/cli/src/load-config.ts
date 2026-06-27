/**
 * Loads a `regel.config.ts` (or `.js`) from the project root, or an explicit path.
 *
 * The config file must default-export the result of `defineConfig()`.
 * When no config file is found, throws a descriptive error.
 */
import * as nodePath from 'node:path';
import * as nodeFs from 'node:fs';
import { Effect } from 'effect';
import type { ResolvedConfig } from '@regeln/core';

const CONFIG_NAMES = [
  'regel.config.ts',
  'regel.config.js',
  'regel.config.mts',
  'regel.config.mjs',
];

export class ConfigNotFoundError extends Error {
  readonly _tag = 'ConfigNotFoundError';
  constructor(readonly projectRoot: string) {
    super(
      `No regel config found in ${projectRoot}.\n` +
        `Create a ${CONFIG_NAMES[0]} that default-exports defineConfig({ rules: [...] }).\n\n` +
        `Example:\n` +
        `  import { defineConfig, select } from '@regeln/core';\n` +
        `  export default defineConfig({ rules: [] });`,
    );
  }
}

export function loadConfig(
  projectRoot: string,
  overrides?: { changedSince?: string | undefined; configPath?: string | undefined },
): Effect.Effect<ResolvedConfig, ConfigNotFoundError> {
  return Effect.gen(function* () {
    const resolvedConfigPath =
      overrides?.configPath !== undefined
        ? nodePath.resolve(overrides.configPath)
        : CONFIG_NAMES.map((name) => nodePath.join(projectRoot, name)).find((p) =>
            nodeFs.existsSync(p),
          );

    if (!resolvedConfigPath) {
      return yield* Effect.fail(new ConfigNotFoundError(projectRoot));
    }

    // Dynamic import works for both .ts (via bun) and .js
    const mod = yield* Effect.tryPromise({
      try: () => import(resolvedConfigPath),
      catch: (e) =>
        new ConfigNotFoundError(
          `${projectRoot} (failed to import ${resolvedConfigPath}: ${String(e)})`,
        ),
    });

    const raw = mod.default ?? mod;
    if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as Record<string, unknown>).rules)) {
      return yield* Effect.fail(
        new ConfigNotFoundError(
          `${projectRoot} (invalid config export in ${resolvedConfigPath} — expected { rules: [...] })`,
        ),
      );
    }
    const config = raw as ResolvedConfig;

    // Apply CLI overrides
    if (overrides?.changedSince !== undefined) {
      return { ...config, changedSince: overrides.changedSince };
    }

    return config;
  });
}

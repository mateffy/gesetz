import { rm, writeFile } from 'node:fs/promises';
import * as nodePath from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { loadConfig } from '../src/load-config';

/**
 * Config fixtures live inside this package so `@gesetz/core` resolves from
 * `packages/cli/node_modules` when jiti imports them.
 */
const HERE = import.meta.dirname;
const written: string[] = [];

async function writeConfig(name: string, body: string): Promise<string> {
  const path = nodePath.join(HERE, name);
  await writeFile(path, body, 'utf8');
  written.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(written.splice(0).map((path) => rm(path, { force: true })));
});

describe('loadConfig projectRoot handling', () => {
  it('keeps the projectRoot the config computed when no override is requested', async () => {
    const configPath = await writeConfig(
      '.tmp-config-default.ts',
      `import { defineConfig } from '@gesetz/core';\nexport default defineConfig({ rules: [] });\n`,
    );

    const config = await Effect.runPromise(loadConfig('/ignored/root', { configPath }));

    // The fixture omits projectRoot, so defineConfig falls back to process.cwd().
    expect(config.projectRoot).toBe(process.cwd());
  });

  it('lets an explicit --project-root win over the config', async () => {
    const configPath = await writeConfig(
      '.tmp-config-override.ts',
      `import { defineConfig } from '@gesetz/core';\nexport default defineConfig({ rules: [] });\n`,
    );

    const config = await Effect.runPromise(
      loadConfig('/project/that/was/requested', { configPath, projectRootOverride: true }),
    );

    expect(config.projectRoot).toBe('/project/that/was/requested');
  });

  it('still applies changedSince alongside the override', async () => {
    const configPath = await writeConfig(
      '.tmp-config-since.ts',
      `import { defineConfig } from '@gesetz/core';\nexport default defineConfig({ rules: [] });\n`,
    );

    const config = await Effect.runPromise(
      loadConfig('/other/root', {
        configPath,
        projectRootOverride: true,
        changedSince: 'origin/main',
      }),
    );

    expect(config.projectRoot).toBe('/other/root');
    expect(config.changedSince).toBe('origin/main');
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { Effect } from 'effect';
import { loadConfig } from '../src/load-config';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-config-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const write = (rel: string, content: string) => writeFile(nodePath.join(dir, rel), content, 'utf8');
const load = (root: string) => Effect.runPromise(loadConfig(root));

describe('loadConfig', () => {
  it('loads a gesetz.config.ts and returns its rules', async () => {
    await write(
      'gesetz.config.ts',
      'export default { rules: [], thresholds: [], exemptions: [], projectRoot: "/x" };',
    );
    const cfg = await load(dir);
    expect(cfg.rules).toEqual([]);
  });

  it('fails when no config file exists, naming the directory', async () => {
    await expect(load(dir)).rejects.toThrow(/No gesetz config found/);
  });

  it('fails when the default export is not a config', async () => {
    await write('gesetz.config.ts', 'export default { nope: true };');
    await expect(load(dir)).rejects.toThrow(/invalid config export/);
  });

  it('fails when the config cannot be imported, and says why', async () => {
    await write('gesetz.config.ts', 'this is not valid typescript at all {{{');
    await expect(load(dir)).rejects.toThrow(/failed to import/);
  });

  it('applies a changedSince override without discarding the rest', async () => {
    await write(
      'gesetz.config.ts',
      'export default { rules: [], thresholds: [], exemptions: [], projectRoot: "/x" };',
    );
    const cfg = await Effect.runPromise(loadConfig(dir, { changedSince: 'main' }));
    expect(cfg.changedSince).toBe('main');
    expect(cfg.projectRoot).toBe('/x');
  });

  it('loads a .js config as well as a .ts one', async () => {
    await write(
      'gesetz.config.js',
      'export default { rules: [], thresholds: [], exemptions: [], projectRoot: "/y" };',
    );
    expect((await load(dir)).projectRoot).toBe('/y');
  });
});

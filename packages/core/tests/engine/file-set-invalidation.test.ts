import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { runAll } from '../../src/engine/runner';
import { defineConfig } from '../../src/engine/config';
import { select } from '../../src/primitives/select';
import { requireTest } from '../../src/primitives/checks/fs';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-fileset-'));
  await mkdir(nodePath.join(dir, 'src'), { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const config = (dbPath: string) =>
  defineConfig({
    projectRoot: dir,
    adapters: [],
    storage: { kind: 'sqlite', path: dbPath },
    rules: [
      select('src/**/*.ts')
        .exclude('src/**/*.test.ts')
        .label('Every source file needs a test')
        .category('testing')
        .check(requireTest()),
    ],
  });

const run = () => Effect.runPromise(runAll(config(nodePath.join(dir, 'cache.db'))));

describe('a cached violation is dropped when the file it was waiting for appears', () => {
  it('reports the missing test on the first run', async () => {
    await writeFile(nodePath.join(dir, 'src/a.ts'), 'export const a = 1;\n');
    const first = await run();
    expect(first.totalViolations).toBe(1);
    expect(first.byRule[0]?.violations[0]?.path).toBe('src/a.ts');
  });

  it('drops it on the next run once the test file exists', async () => {
    // The source file never changes, so nothing about its content hash moves and
    // the marker for it would otherwise be reused verbatim. Only the file *set*
    // changed, which is why the file set is part of the rule's fingerprint.
    await writeFile(nodePath.join(dir, 'src/a.ts'), 'export const a = 1;\n');
    expect((await run()).totalViolations).toBe(1);

    await writeFile(nodePath.join(dir, 'src/a.test.ts'), 'export const t = 1;\n');
    expect((await run()).totalViolations).toBe(0);
  });

  it('brings the violation back when the test file is deleted again', async () => {
    await writeFile(nodePath.join(dir, 'src/a.ts'), 'export const a = 1;\n');
    await writeFile(nodePath.join(dir, 'src/a.test.ts'), 'export const t = 1;\n');
    expect((await run()).totalViolations).toBe(0);

    await rm(nodePath.join(dir, 'src/a.test.ts'));
    expect((await run()).totalViolations).toBe(1);
  });

  it('still reuses cached results when the file set is unchanged', async () => {
    await writeFile(nodePath.join(dir, 'src/a.ts'), 'export const a = 1;\n');
    const first = await run();
    expect(await run()).toEqual(first);
  });
});

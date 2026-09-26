import { mkdtemp, rm, writeFile, mkdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { runAll } from '../../src/engine/runner';
import { defineConfig } from '../../src/engine/config';
import { select } from '../../src/primitives/select';
import type { Check } from '../../src/engine/rule';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-incremental-'));
  await mkdir(nodePath.join(dir, 'src'), { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const noConsoleLog: Check = async (file) =>
  file.content.includes('console.log')
    ? [{ message: 'no console.log', path: file.path, severity: 'error', source: 'core' }]
    : [];

function config(dbPath: string) {
  return defineConfig({
    projectRoot: dir,
    storage: { kind: 'sqlite', path: dbPath },
    rules: [select('src/**/*.ts').label('No console log').category('cleanup').check(noConsoleLog)],
  });
}

const run = (cfg: ReturnType<typeof config>) => Effect.runPromise(runAll(cfg));

describe('runAll incremental caching (sqlite storage)', () => {
  it('serves identical results from the cache on a second run', async () => {
    const dbPath = nodePath.join(dir, 'cache.db');
    await writeFile(nodePath.join(dir, 'src/dirty.ts'), 'console.log("x");\n');
    await writeFile(nodePath.join(dir, 'src/clean.ts'), 'export const x = 1;\n');

    const first = await run(config(dbPath));
    expect(first.totalViolations).toBe(1);
    expect(first.byRule[0]?.violations[0]?.path).toBe('src/dirty.ts');

    const second = await run(config(dbPath));
    expect(second).toEqual(first);
  });

  it('re-checks only the edited file', async () => {
    const dbPath = nodePath.join(dir, 'cache.db');
    await writeFile(nodePath.join(dir, 'src/dirty.ts'), 'console.log("x");\n');
    await writeFile(nodePath.join(dir, 'src/clean.ts'), 'export const x = 1;\n');
    await run(config(dbPath));

    await writeFile(nodePath.join(dir, 'src/dirty.ts'), 'export const fixed = true;\n');
    const result = await run(config(dbPath));
    expect(result.totalViolations).toBe(0);
  });

  it('drops violations of deleted files', async () => {
    const dbPath = nodePath.join(dir, 'cache.db');
    await writeFile(nodePath.join(dir, 'src/dirty.ts'), 'console.log("x");\n');
    const first = await run(config(dbPath));
    expect(first.totalViolations).toBe(1);

    await unlink(nodePath.join(dir, 'src/dirty.ts'));
    const second = await run(config(dbPath));
    expect(second.totalViolations).toBe(0);
  });

  it('reprocesses everything when the rule set changes (fingerprint)', async () => {
    const dbPath = nodePath.join(dir, 'cache.db');
    await writeFile(nodePath.join(dir, 'src/a.ts'), 'export const a = 1;\n');
    const first = await run(config(dbPath));
    expect(first.byRule).toHaveLength(1);

    const withTwoRules = defineConfig({
      projectRoot: dir,
      storage: { kind: 'sqlite', path: dbPath },
      rules: [
        select('src/**/*.ts').label('No console log').check(noConsoleLog),
        select('src/**/*.ts')
          .label('No default export')
          .check(async (file) =>
            file.content.includes('export default')
              ? [
                  {
                    message: 'no default export',
                    path: file.path,
                    severity: 'warn',
                    source: 'core',
                  },
                ]
              : [],
          ),
      ],
    });
    const second = await run(withTwoRules);
    expect(second.byRule).toHaveLength(2);
    // and back to one rule — stale markers of the removed rule must be gone
    const third = await run(config(dbPath));
    expect(third.byRule).toHaveLength(1);
  });

  it('filters violations by --files globs at aggregation time', async () => {
    const dbPath = nodePath.join(dir, 'cache.db');
    await writeFile(nodePath.join(dir, 'src/dirty.ts'), 'console.log("x");\n');
    const cfg = config(dbPath);
    const unfiltered = await Effect.runPromise(runAll(cfg));
    expect(unfiltered.totalViolations).toBe(1);

    const filtered = await Effect.runPromise(
      runAll(config(dbPath), { fileFilter: ['src/other/**'] }),
    );
    expect(filtered.totalViolations).toBe(0);
  });
});

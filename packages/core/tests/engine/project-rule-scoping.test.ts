import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { runAll } from '../../src/engine/runner';
import { defineConfig, type ResolvedConfig } from '../../src/engine/config';
import { select } from '../../src/primitives/select';
import type { Check, Rule, Violation } from '../../src/engine/rule';

let dir: string;
let dbPath: string;

beforeEach(async () => {
  dir = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-project-cache-'));
  await mkdir(nodePath.join(dir, 'src'), { recursive: true });
  await mkdir(nodePath.join(dir, '.gesetz'), { recursive: true });
  dbPath = nodePath.join(dir, '.gesetz', 'cache.db');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const write = (relative: string, content: string) => writeFile(nodePath.join(dir, relative), content, 'utf8');

const config = (rules: ResolvedConfig['rules']): ResolvedConfig =>
  defineConfig({ projectRoot: dir, adapters: [], rules, storage: { kind: 'sqlite', path: dbPath } });

const run = (rules: ResolvedConfig['rules'], fileFilter?: readonly string[]) =>
  Effect.runPromise(runAll(config(rules), fileFilter === undefined ? {} : { fileFilter: [...fileFilter] }));

const violationsFor = (result: { byRule: readonly { ruleId: string; violations: readonly Violation[] }[] }, ruleId: string) =>
  result.byRule.find((r) => r.ruleId === ruleId)?.violations ?? [];

/** A project rule that records how many times it ran, and flags BAD files. */
const countingRule = (runs: string[]): Rule => ({
  id: 'project-rule',
  description: 'project rule',
  run: Effect.succeed([]),
  project: {
    patterns: ['src/**/*.ts'],
    // A project rule covers its whole file set — that is what makes its cached
    // result safe to key by the files it covers — and a `--files` request narrows
    // that set. This one enumerates its own files the way an adapter runs its tool
    // over its own patterns.
    run: async (ctx) => {
      runs.push(ctx.requestedPaths?.join(',') ?? 'all');
      const { readdir, readFile } = await import('node:fs/promises');
      const all: string[] = [];
      const walk = async (dir: string): Promise<void> => {
        for (const entry of await readdir(nodePath.join(ctx.rootDir, dir), { withFileTypes: true })) {
          const relative = dir === '' ? entry.name : `${dir}/${entry.name}`;
          if (entry.isDirectory()) await walk(relative);
          else if (relative.startsWith('src/') && relative.endsWith('.ts')) all.push(relative);
        }
      };
      await walk('');
      const scope = ctx.requestedPaths ?? all;
      const violations: Violation[] = [];
      for (const path of scope) {
        const content = await readFile(nodePath.join(ctx.rootDir, path), 'utf8');
        if (content.includes('BAD')) {
          violations.push({ rule: 'project-rule', message: 'bad', path, severity: 'error', source: 'custom' });
        }
      }
      return violations;
    },
  },
});

describe('a project rule result is cached per question', () => {
  it('does not serve a scoped result to an unscoped run', async () => {
    // The failure this guards against: a run that examined one file writes an entry
    // that a later full run reads as "the project is clean".
    await write('src/a.ts', 'export const a = "BAD";\n');
    await write('src/b.ts', 'export const b = "BAD";\n');

    const scoped = await run([countingRule([])], ['src/a.ts']);
    expect(violationsFor(scoped, 'project-rule').map((v) => v.path)).toEqual(['src/a.ts']);

    const full = await run([countingRule([])]);
    expect(violationsFor(full, 'project-rule').map((v) => v.path).sort()).toEqual([
      'src/a.ts',
      'src/b.ts',
    ]);
  });

  it('does not serve an unscoped result to a scoped run', async () => {
    await write('src/a.ts', 'export const a = "BAD";\n');
    await write('src/b.ts', 'export const b = "BAD";\n');

    const full = await run([countingRule([])]);
    expect(violationsFor(full, 'project-rule')).toHaveLength(2);

    const scoped = await run([countingRule([])], ['src/a.ts']);
    expect(violationsFor(scoped, 'project-rule').map((v) => v.path)).toEqual(['src/a.ts']);
  });

  it('reuses the entry when nothing about the question changed', async () => {
    await write('src/a.ts', 'export const a = 1;\n');
    const runs: string[] = [];
    await run([countingRule(runs)]);
    await run([countingRule(runs)]);
    // One invocation for two runs: the second was served from the cache.
    expect(runs).toHaveLength(1);
  });

  it('re-runs when a covered file changes', async () => {
    await write('src/a.ts', 'export const a = 1;\n');
    const runs: string[] = [];
    await run([countingRule(runs)]);
    await write('src/a.ts', 'export const a = 2;\n');
    await run([countingRule(runs)]);
    expect(runs).toHaveLength(2);
  });

  it('re-runs when a file appears, because the covered set changed', async () => {
    await write('src/a.ts', 'export const a = 1;\n');
    const runs: string[] = [];
    await run([countingRule(runs)]);
    await write('src/b.ts', 'export const b = 2;\n');
    await run([countingRule(runs)]);
    expect(runs).toHaveLength(2);
  });
});

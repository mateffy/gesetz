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
let db: string;

beforeEach(async () => {
  dir = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-request-'));
  await mkdir(nodePath.join(dir, 'src'), { recursive: true });
  // The cache lives under .gesetz/, which the file walk skips: a database inside
  // the walked tree changes the file set on first write.
  await mkdir(nodePath.join(dir, '.gesetz'), { recursive: true });
  db = nodePath.join(dir, '.gesetz', 'cache.db');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const write = async (relative: string, content: string) => {
  const absolute = nodePath.join(dir, relative);
  await mkdir(nodePath.dirname(absolute), { recursive: true });
  await writeFile(absolute, content, 'utf8');
};

const config = (rules: ResolvedConfig['rules']): ResolvedConfig =>
  defineConfig({ projectRoot: dir, adapters: [], rules, storage: { kind: 'sqlite', path: db } });

const run = (rules: ResolvedConfig['rules'], fileFilter?: readonly string[]) =>
  Effect.runPromise(
    runAll(config(rules), fileFilter === undefined ? {} : { fileFilter: [...fileFilter] }),
  );

/** A check that records the files it was handed, and flags the string BAD. */
const recording =
  (seen: string[]): Check =>
  async (file) => {
    seen.push(file.path);
    return file.content.includes('BAD')
      ? [
          {
            rule: 'flag-bad',
            message: 'bad',
            path: file.path,
            severity: 'error' as const,
            source: 'core' as const,
          },
        ]
      : [];
  };

/** The one rule these tests exercise: reports what it saw, flags BAD. */
const flagBadCheck = (check: Check): Rule =>
  select('src/**/*.ts').exclude('**/*.test.ts').label('Flag bad').category('cleanup').check(check);

/** Violations reported for one rule id, which is what the caller reads. */
const violationsFor = (
  result: { byRule: readonly { ruleId: string; violations: readonly Violation[] }[] },
  ruleId: string,
): readonly Violation[] => result.byRule.find((r) => r.ruleId === ruleId)?.violations ?? [];

describe('--files reduces the work, not just the report', () => {
  it('does not run a rule that cannot match any requested file', async () => {
    await write('src/a.ts', 'export const a = 1;\n');
    await write('app/Model.php', '<?php BAD');
    const ranTs: string[] = [];
    const ranPhp: string[] = [];

    const rules = [
      select('src/**/*.ts').label('Flag bad').category('cleanup').check(recording(ranTs)),
      select('app/**/*.php').label('PHP').category('cleanup').check(recording(ranPhp)),
    ];

    await run(rules, ['src/**/*.ts']);

    expect(ranTs).toEqual(['src/a.ts']);
    // The PHP rule has nothing to say about src/, so it never ran at all.
    expect(ranPhp).toEqual([]);
  });

  it('reports only the requested files, and does not recompute the others', async () => {
    // A scoped run computes the requested files and leaves every other file's
    // cached result exactly as it was: it neither reports them nor erases what it
    // did not look at.
    await write('src/a.ts', 'export const a = "BAD";\n');
    await write('src/b.ts', 'export const b = "BAD";\n');
    const first: string[] = [];
    await run(
      [select('src/**/*.ts').label('Flag bad').category('cleanup').check(recording(first))],
      ['src/a.ts', 'src/b.ts'],
    );
    expect(first.slice().sort()).toEqual(['src/a.ts', 'src/b.ts']);

    const seen: string[] = [];
    const scoped = await run([
      select('src/**/*.ts').label('Flag bad').category('cleanup').check(recording(seen)),
    ], ['src/a.ts']);

    // A scoped run touches only the files it was asked about, and it has its own
    // cache scope, so the unscoped results are neither recomputed nor disturbed.
    expect(seen).toEqual(['src/a.ts']);
    expect(violationsFor(scoped, 'flag-bad').map((v) => v.path)).toEqual(['src/a.ts']);

    // And the other file is still known, not forgotten.
    const both = await run([
      select('src/**/*.ts').label('Flag bad').category('cleanup').check(recording([])),
    ]);
    expect(violationsFor(both, 'flag-bad').map((v) => v.path).sort()).toEqual([
      'src/a.ts',
      'src/b.ts',
    ]);
  });

  it('gives a project rule a changed list narrowed to the request', async () => {
    await write('src/a.ts', 'export const a = 1;\n');
    await write('src/b.ts', 'export const b = 2;\n');
    const contexts: { changed: readonly string[]; requested: readonly string[] | null }[] = [];

    const rule: Rule = {
      id: 'probe',
      description: 'probe',
      run: Effect.succeed([]),
      project: {
        patterns: ['src/**/*.ts'],
        run: async (ctx) => {
          contexts.push({ changed: ctx.changedFiles, requested: ctx.requestedPaths ?? null });
          return [];
        },
      },
    };

    await run([rule], ['src/a.ts']);

    // The rule is told what was asked for, so it can hand its tool fewer paths. On
    // this engine `changedFiles` stays what the scan reprocessed; the request is
    // what narrows the tool.
    expect(contexts.at(-1)?.requested).toEqual(['src/a.ts']);
    // A scoped run reads and reprocesses only what was requested, so `changedFiles`
    // is that same subset — the rule is told both, and narrows its tool with them.
    expect(contexts.at(-1)?.changed).toEqual(['src/a.ts']);
  });

  it('tells an unscoped rule that nothing was requested', async () => {
    await write('src/a.ts', 'export const a = 1;\n');
    const seen: (readonly string[] | null)[] = [];
    const rule: Rule = {
      id: 'probe',
      description: 'probe',
      run: Effect.succeed([]),
      project: {
        patterns: ['src/**/*.ts'],
        run: async (ctx) => {
          seen.push(ctx.requestedPaths ?? null);
          return [];
        },
      },
    };

    await run([rule]);
    expect(seen.at(-1)).toBeNull();
  });

  it('still walks every file, because discovery is global', async () => {
    // The one cost --files does not remove: the scan stats and hashes the whole
    // project so that unchanged files can be reused. Everything after the scan is
    // narrowed.
    await write('src/a.ts', 'export const a = 1;\n');
    await write('src/b.ts', 'export const b = 2;\n');
    const scans: number[] = [];
    await Effect.runPromise(
      runAll(config([flagBadCheck(recording([]))]), {
        fileFilter: ['src/a.ts'],
        onScan: (scan) => scans.push(scan.filesSeen),
      }),
    );
    expect(scans).toEqual([2]);
  });
});

describe('--files and the cache', () => {
  it('serves an unchanged requested file from the cache', async () => {
    await write('src/a.ts', 'export const a = "BAD";\n');
    const first = await run([flagBadCheck(recording([]))], ['src/a.ts']);
    expect(violationsFor(first, 'flag-bad').map((v) => v.path)).toEqual(['src/a.ts']);

    // Second scoped run with nothing edited: the mark is already current, so the
    // check does not run — and the violation is still reported, from the mark.
    const seen: string[] = [];
    const second = await run([flagBadCheck(recording(seen))], ['src/a.ts']);
    expect(seen).toEqual([]);
    expect(violationsFor(second, 'flag-bad').map((v) => v.path)).toEqual(['src/a.ts']);
  });

  it('re-runs the check when the requested file changes', async () => {
    await write('src/a.ts', 'export const a = 1;\n');
    const seen: string[] = [];
    await run([flagBadCheck(recording(seen))], ['src/a.ts']);
    expect(seen).toEqual(['src/a.ts']);

    await write('src/a.ts', 'export const a = "BAD";\n');
    const second = await run([flagBadCheck(recording([]))], ['src/a.ts']);
    expect(violationsFor(second, 'flag-bad').map((v) => v.path)).toEqual(['src/a.ts']);
  });

  it('does not clear the marks of files outside the request', async () => {
    await write('src/a.ts', 'export const a = "BAD";\n');
    await write('src/b.ts', 'export const b = "BAD";\n');

    const full = await run([flagBadCheck(recording([]))]);
    expect(
      violationsFor(full, 'flag-bad')
        .map((v) => v.path)
        .sort(),
    ).toEqual(['src/a.ts', 'src/b.ts']);

    // A scoped run for a.ts alone must leave b.ts's mark standing.
    await write('src/a.ts', 'export const a = "fine";\n');
    const scoped = await run([flagBadCheck(recording([]))], ['src/a.ts']);
    // b.ts is not in the request, so nothing about it is reported either way.
    expect(violationsFor(scoped, 'flag-bad')).toEqual([]);

    // And the next unscoped run still reports b.ts: nothing was lost.
    const again = await run([flagBadCheck(recording([]))]);
    expect(violationsFor(again, 'flag-bad').map((v) => v.path)).toEqual(['src/b.ts']);
  });

  it('does not hide a later change to a file the scoped run did not look at', async () => {
    await write('src/a.ts', 'export const a = 1;\n');
    await write('src/b.ts', 'export const b = 2;\n');

    // A scoped run touches only a.ts.
    await run([flagBadCheck(recording([]))], ['src/a.ts']);

    // b.ts changes afterwards. The next full run must see it.
    await write('src/b.ts', 'export const b = "BAD";\n');
    const full = await run([flagBadCheck(recording([]))]);
    expect(violationsFor(full, 'flag-bad').map((v) => v.path)).toEqual(['src/b.ts']);
  });

  it('re-checks a requested file that the previous scoped run did not cover', async () => {
    await write('src/a.ts', 'export const a = 1;\n');
    await write('src/b.ts', 'export const b = "BAD";\n');

    await run([flagBadCheck(recording([]))], ['src/a.ts']);
    const scopedToB = await run([flagBadCheck(recording([]))], ['src/b.ts']);
    expect(violationsFor(scopedToB, 'flag-bad').map((v) => v.path)).toEqual(['src/b.ts']);
  });
});

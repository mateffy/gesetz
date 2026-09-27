import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { typescriptSyntaxBackend } from '@gesetz/typescript';
import { runAll } from '../../src/engine/runner';
import { defineConfig, type ResolvedConfig } from '../../src/engine/config';
import type { Rule, Violation } from '../../src/engine/rule';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-scoped-rule-'));
  await mkdir(nodePath.join(dir, 'src'), { recursive: true });
  await mkdir(nodePath.join(dir, '.gesetz'), { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const write = (relative: string, content: string) =>
  writeFile(nodePath.join(dir, relative), content, 'utf8');

// The cache database lives under `.gesetz/`, which the file walk skips. A
// database inside the walked tree would change the file set on first write and
// make the next run reprocess everything — which is what this suite must not do,
// because the whole point is that only a.ts is reprocessed.
const config = (rules: ResolvedConfig['rules'], dbPath: string): ResolvedConfig =>
  defineConfig({
    projectRoot: dir,
    adapters: [typescriptSyntaxBackend],
    rules,
    storage: { kind: 'sqlite', path: dbPath },
  });

const run = (cfg: ResolvedConfig) => Effect.runPromise(runAll(cfg));

const violationsFor = (result: Awaited<ReturnType<typeof run>>, ruleId: string): Violation[] =>
  result.byRule.find((r) => r.ruleId === ruleId)?.violations ?? [];

/**
 * A rule shaped like a real file-scoped adapter: it examines only the files this
 * scan reprocessed, and reports which paths those were.
 */
function scopedRule(): Rule {
  return {
    id: 'scoped-flagger',
    description: 'Flags files containing BAD, examining only changed files',
    // Project rules never run this; the field exists on every Rule.
    run: Effect.succeed([]),
    project: {
      patterns: ['src/**/*.ts'],
      run: async (ctx) => {
        const examined = ctx.changedFiles.filter((path) => path.startsWith('src/'));
        const violations: Violation[] = [];
        for (const path of examined) {
          const file = await ctx.network.file(path);
          if (file !== null && (await file.content()).includes('BAD')) {
            violations.push({
              rule: 'scoped-flagger',
              message: 'contains BAD',
              path,
              severity: 'error',
              source: 'custom',
            });
          }
        }
        return { violations, examinedPaths: examined };
      },
    },
  };
}

/** The same rule without `examinedPaths`: it claims to have examined everything. */
function wholesaleRule(): Rule {
  const rule = scopedRule();
  return {
    ...rule,
    run: Effect.succeed([]),
    project: {
      patterns: rule.project!.patterns,
      run: async (ctx) => {
        const outcome = await rule.project!.run(ctx);
        return 'violations' in outcome ? outcome.violations : outcome;
      },
    },
  };
}

describe('a project rule that reports the paths it examined', () => {
  it('keeps the violations of files it did not look at', async () => {
    // The failure this guards against: markers for a project rule are replaced
    // wholesale, so a rule that examined one file would clear the marks of every
    // other file — and the gate would report a clean project it never checked.
    const dbPath = nodePath.join(dir, '.gesetz', 'cache.db');
    await write('src/a.ts', 'export const a = "BAD";\n');
    await write('src/b.ts', 'export const b = "BAD";\n');

    const first = await run(config([scopedRule()], dbPath));
    expect(
      violationsFor(first, 'scoped-flagger')
        .map((v) => v.path)
        .sort(),
    ).toEqual(['src/a.ts', 'src/b.ts']);

    // Fix only a.ts. b.ts is not reprocessed, so it is not examined.
    await write('src/a.ts', 'export const a = "fine";\n');
    const second = await run(config([scopedRule()], dbPath));
    const stillFlagged = violationsFor(second, 'scoped-flagger');
    expect(stillFlagged.map((v) => v.path)).toEqual(['src/b.ts']);
  });

  it('clears the violation of a file it examined and found clean', async () => {
    const dbPath = nodePath.join(dir, '.gesetz', 'cache.db');
    await write('src/a.ts', 'export const a = "BAD";\n');
    expect(violationsFor(await run(config([scopedRule()], dbPath)), 'scoped-flagger')).toHaveLength(
      1,
    );

    await write('src/a.ts', 'export const a = "fine";\n');
    const second = await run(config([scopedRule()], dbPath));
    expect(violationsFor(second, 'scoped-flagger')).toEqual([]);
  });

  it('flags a file that becomes bad after a clean first run', async () => {
    const dbPath = nodePath.join(dir, '.gesetz', 'cache.db');
    await write('src/a.ts', 'export const a = "fine";\n');
    expect(violationsFor(await run(config([scopedRule()], dbPath)), 'scoped-flagger')).toEqual([]);

    await write('src/a.ts', 'export const a = "BAD";\n');
    const second = await run(config([scopedRule()], dbPath));
    expect(violationsFor(second, 'scoped-flagger').map((v) => v.path)).toEqual(['src/a.ts']);
  });

  it('examines every file on the first scan, so nothing is missed at the start', async () => {
    const dbPath = nodePath.join(dir, '.gesetz', 'cache.db');
    await write('src/a.ts', 'export const a = "BAD";\n');
    await write('src/b.ts', 'export const b = "BAD";\n');
    await write('src/c.ts', 'export const c = "fine";\n');
    const result = await run(config([scopedRule()], dbPath));
    expect(violationsFor(result, 'scoped-flagger')).toHaveLength(2);
  });
});

describe('a project rule that reports only violations', () => {
  it('still replaces its marks wholesale', async () => {
    // Unchanged behaviour for every existing rule: the whole project was
    // examined, so a path with no violation is a path that is clean.
    const dbPath = nodePath.join(dir, '.gesetz', 'cache.db');
    await write('src/a.ts', 'export const a = "BAD";\n');
    await write('src/b.ts', 'export const b = "BAD";\n');
    expect(
      violationsFor(await run(config([wholesaleRule()], dbPath)), 'scoped-flagger'),
    ).toHaveLength(2);

    await write('src/a.ts', 'export const a = "fine";\n');
    await write('src/b.ts', 'export const b = "fine";\n');
    const second = await run(config([wholesaleRule()], dbPath));
    expect(violationsFor(second, 'scoped-flagger')).toEqual([]);
  });
});

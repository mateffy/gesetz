import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { runAll, type RunResult } from '../../src/engine/runner';
import { defineConfig, type ResolvedConfig } from '../../src/engine/config';
import { select } from '../../src/primitives/select';
import { buildBaselineFile, STALE_RULE_ID, type BaselineFile } from '../../src/engine/baseline';
import type { Check, Violation } from '../../src/engine/rule';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-runner-baseline-'));
  await mkdir(nodePath.join(dir, 'src'), { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Reports one violation per line containing `needle`. */
const flagLines: Check = async (file) => {
  const violations: Violation[] = [];
  file.content.split('\n').forEach((line, index) => {
    if (line.includes('FLAG')) {
      violations.push({
        message: 'guard is forbidden here',
        path: file.path,
        line: index + 1,
        severity: 'error',
        source: 'core',
      });
    }
  });
  return violations;
};

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return defineConfig({
    projectRoot: dir,
    storage: { kind: 'memory' },
    rules: [select('src/**/*.ts').label('No flag').category('cleanup').check(flagLines)],
    ...overrides,
  });
}

const run = (config: ResolvedConfig, options: { baseline?: BaselineFile | null } = {}) =>
  Effect.runPromise(runAll(config, options));

async function baselineFor(config: ResolvedConfig): Promise<BaselineFile> {
  const result = await run(config);
  return buildBaselineFile(
    result.byRule.map((rule) => ({ rule: rule.ruleId, violations: rule.violations })),
    { gesetzVersion: 'test' },
  );
}

const write = (relative: string, content: string) =>
  writeFile(nodePath.join(dir, relative), content);

const read = (result: RunResult) => result.byRule.find((rule) => rule.ruleId === 'no-flag');

describe('runAll with a baseline', () => {
  it('keeps a violation baselined when ten lines are added above it', async () => {
    await write('src/a.ts', 'FLAG\n');
    const baseline = await baselineFor(makeConfig());

    await write('src/a.ts', `${'const x = 1;\n'.repeat(10)}FLAG\n`);
    const result = await run(makeConfig(), { baseline });

    expect(result.baseline?.new).toBe(0);
    expect(result.baseline?.baselined).toBe(1);
    expect(result.baseline?.stale).toBe(0);
    expect(result.passing).toBe(true);
    expect(read(result)?.violations).toEqual([]);
  });

  it('fails on a fourth violation in a file with three baselined', async () => {
    await write('src/a.ts', 'FLAG\nFLAG\nFLAG\n');
    const baseline = await baselineFor(makeConfig());
    expect(baseline.total).toBe(3);

    await write('src/a.ts', 'FLAG\nFLAG\nFLAG\nFLAG\n');
    const result = await run(makeConfig(), { baseline });

    expect(result.baseline?.new).toBe(1);
    expect(result.baseline?.baselined).toBe(3);
    expect(result.passing).toBe(false);
    expect(result.totalViolations).toBe(1);
    expect(read(result)?.violations).toHaveLength(1);
  });

  it('reports a stale entry when a baselined violation is fixed', async () => {
    await write('src/a.ts', 'FLAG\nFLAG\n');
    const baseline = await baselineFor(makeConfig());

    await write('src/a.ts', 'FLAG\n');
    const result = await run(makeConfig(), { baseline });

    expect(result.baseline?.stale).toBe(1);
    expect(result.baseline?.baselined).toBe(1);
    expect(result.passing).toBe(false);
    const stale = result.byRule.find((rule) => rule.ruleId === STALE_RULE_ID);
    expect(stale?.violations).toHaveLength(1);
    expect(stale?.violations[0]?.path).toBe('src/a.ts');
  });

  it('excludes baselined violations from the score but still counts them', async () => {
    await write('src/a.ts', `${'FLAG\n'.repeat(5)}`);
    const baseline = await baselineFor(makeConfig());

    const withBaseline = await run(makeConfig(), { baseline });
    expect(withBaseline.byCategory[0]?.score).toBe(10);
    expect(withBaseline.baseline?.baselined).toBe(5);
    expect(withBaseline.baseline?.new).toBe(0);
    expect(withBaseline.passing).toBe(true);

    const full = await run(makeConfig(), { baseline: null });
    expect(full.byCategory[0]?.score).toBe(5);
    expect(full.totalViolations).toBe(5);
    expect(full.baseline).toBeUndefined();
  });

  it('fully enforces a file that has no baseline entries', async () => {
    await write('src/a.ts', 'FLAG\n');
    const baseline = await baselineFor(makeConfig());

    await write('src/b.ts', 'FLAG\n');
    const result = await run(makeConfig(), { baseline });

    expect(result.baseline?.new).toBe(1);
    expect(result.baseline?.baselined).toBe(1);
    expect(result.passing).toBe(false);
    expect(read(result)?.violations[0]?.path).toBe('src/b.ts');
  });

  it('reports the full inventory when no baseline is used', async () => {
    await write('src/a.ts', 'FLAG\n');
    await write('src/b.ts', 'FLAG\n');
    const result = await run(makeConfig());

    expect(result.totalViolations).toBe(2);
    expect(result.baseline).toBeUndefined();
  });

  it('still applies exemptions when a baseline is active', async () => {
    await write('src/a.ts', 'FLAG\n');
    const config = makeConfig({
      exemptions: [{ path: 'src/**', reason: 'deliberate exception', rule: 'no-flag' }],
    });
    const baseline = await baselineFor(config);

    const result = await run(config, { baseline });
    expect(result.totalViolations).toBe(0);
    expect(result.baseline?.baselined).toBe(0);
    expect(result.baseline?.new).toBe(0);
    expect(result.passing).toBe(true);
  });

  it('lets an exemption suppress stale entries during a cleanup', async () => {
    await write('src/a.ts', 'FLAG\n');
    const baseline = await baselineFor(makeConfig());
    await write('src/a.ts', 'const fixed = true;\n');

    const result = await run(
      makeConfig({
        exemptions: [{ path: '**', reason: 'cleanup in progress', rule: STALE_RULE_ID }],
      }),
      { baseline },
    );
    expect(result.baseline?.stale).toBe(0);
    expect(result.byRule.some((rule) => rule.ruleId === STALE_RULE_ID)).toBe(false);
    expect(result.passing).toBe(true);
  });
});

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function git(...args: string[]): void {
  execFileSync('git', args, {
    cwd: dir,
    stdio: 'ignore',
    env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com' },
  });
}

describe('runAll with a baseline and --since', () => {
  it.skipIf(!hasGit)(
    'examines only changed files and never calls an unexamined entry stale',
    async () => {
      git('init');
      await write('src/a.ts', 'FLAG\n');
      await write('src/b.ts', 'export const b = 1;\n');
      git('add', '-A');
      git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-m', 'init');

      const baseline = await baselineFor(makeConfig());
      expect(baseline.total).toBe(1);

      await write('src/b.ts', 'FLAG\n');
      const result = await run(makeConfig({ changedSince: 'HEAD' }), { baseline });

      expect(result.baseline?.new).toBe(1);
      expect(result.baseline?.stale).toBe(0);
      expect(result.baseline?.baselined).toBe(0);
      expect(read(result)?.violations[0]?.path).toBe('src/b.ts');
    },
    // Git init, a commit, and a full run. That is fast on an idle machine and can
    // outlast the 5s default when the whole suite runs in parallel.
    30_000,
  );
});

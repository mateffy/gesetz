import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { Effect, Layer } from 'effect';
import { runAll, applyExemptions } from '../../src/engine/runner';
import { defineConfig } from '../../src/engine/config';
import type { Rule, Violation } from '../../src/engine/rule';
import { MemoryFileSystem, ProjectRootLive, FileFilterLive } from '../../src/services/fs';
import { SyntaxTreeStub } from '../../src/services/syntax-tree';
import { ImportResolverDefault } from '../../src/services/import-resolver';

const TestLayer = Layer.mergeAll(
  MemoryFileSystem({}),
  SyntaxTreeStub,
  ImportResolverDefault,
  ProjectRootLive(process.cwd()),
  FileFilterLive(null),
);
// eslint-disable-next-line @typescript-eslint/no-explicit-any

function makeRule(id: string, violations: Violation[]): Rule {
  return {
    id,
    description: `Rule ${id}`,
    run: Effect.succeed(violations),
  };
}

function makeThrowingRule(id: string): Rule {
  return {
    id,
    description: `Rule ${id}`,
    // Rules should not fail, but we test defensive catching
    run: Effect.die(new Error('oops')) as unknown as Rule['run'],
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any

const violation = (path: string, ruleId: string): Violation => ({
  rule: ruleId,
  message: 'test violation',
  path,
  severity: 'error',
  source: 'core',
});

describe('applyExemptions', () => {
  it('returns all violations when no exemptions', () => {
    const v = violation('src/foo.ts', 'my-rule');
    expect(applyExemptions([v], [], 'my-rule')).toEqual([v]);
  });

  it('removes violations matching exemption path and rule', () => {
    const v = violation('src/foo.ts', 'my-rule');
    const exempt = [{ path: 'src/**', reason: 'test', rule: 'my-rule' }];
    expect(applyExemptions([v], exempt, 'my-rule')).toEqual([]);
  });

  it('removes violations when rule glob is absent (matches all rules)', () => {
    const v = violation('src/foo.ts', 'my-rule');
    const exempt = [{ path: 'src/**', reason: 'test' }];
    expect(applyExemptions([v], exempt, 'my-rule')).toEqual([]);
  });

  it('keeps violations when path does not match exemption', () => {
    const v = violation('other/foo.ts', 'my-rule');
    const exempt = [{ path: 'src/**', reason: 'test' }];
    expect(applyExemptions([v], exempt, 'my-rule')).toEqual([v]);
  });

  it('does NOT exempt when exemption is expired', () => {
    const v = violation('src/foo.ts', 'my-rule');
    const exempt = [{ path: 'src/**', reason: 'test', until: '2020-01-01' }];
    expect(applyExemptions([v], exempt, 'my-rule')).toEqual([v]);
  });

  it('exempts when until is in the future', () => {
    const v = violation('src/foo.ts', 'my-rule');
    const exempt = [{ path: 'src/**', reason: 'test', until: '2099-01-01' }];
    expect(applyExemptions([v], exempt, 'my-rule')).toEqual([]);
  });
});

describe('runAll', () => {
  it('returns empty results when all rules pass', async () => {
    const config = defineConfig({ rules: [makeRule('rule-1', []), makeRule('rule-2', [])] });
    const result = await Effect.runPromise(Effect.provide(runAll(config), TestLayer));
    expect(result.totalViolations).toBe(0);
    expect(result.byRule).toHaveLength(2);
  });

  it('collects violations from all rules', async () => {
    const config = defineConfig({
      rules: [
        makeRule('rule-a', [violation('src/a.ts', 'rule-a')]),
        makeRule('rule-b', [violation('src/b.ts', 'rule-b'), violation('src/c.ts', 'rule-b')]),
      ],
    });
    const result = await Effect.runPromise(Effect.provide(runAll(config), TestLayer));
    expect(result.totalViolations).toBe(3);
    expect(result.byRule[0]?.violations).toHaveLength(1);
    expect(result.byRule[1]?.violations).toHaveLength(2);
  });

  it('applies exemptions to violations', async () => {
    const config = defineConfig({
      rules: [makeRule('rule-a', [violation('src/a.ts', 'rule-a')])],
      exemptions: [{ path: 'src/**', reason: 'test', rule: 'rule-a' }],
    });
    const result = await Effect.runPromise(Effect.provide(runAll(config), TestLayer));
    expect(result.totalViolations).toBe(0);
  });

  it('catches rule defects and reports without stopping other rules', async () => {
    const config = defineConfig({
      rules: [makeThrowingRule('broken-rule'), makeRule('good-rule', [])],
    });
    const result = await Effect.runPromise(Effect.provide(runAll(config), TestLayer));
    expect(result.byRule).toHaveLength(2);
    const brokenResult = result.byRule.find((r) => r.ruleId === 'broken-rule');
    expect(brokenResult?.violations).toHaveLength(1);
    expect(brokenResult?.violations[0]?.message).toContain('unexpected error');
    const goodResult = result.byRule.find((r) => r.ruleId === 'good-rule');
    expect(goodResult?.violations).toHaveLength(0);
  });

  it('projectRoot defaults to process.cwd()', () => {
    const config = defineConfig({ rules: [] });
    expect(config.projectRoot).toBe(process.cwd());
  });
});

describe('runAll rule failures', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-rule-failure-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeFailingProjectRule(id: string, counter: { calls: number }): Rule {
    return {
      id,
      description: `Rule ${id}`,
      run: Effect.succeed([]),
      project: {
        patterns: ['**/*'],
        run: async () => {
          counter.calls += 1;
          throw new Error('adapter exploded');
        },
      },
    };
  }

  it('reports a failing project rule as a critical violation', async () => {
    const counter = { calls: 0 };
    const config = defineConfig({
      projectRoot: dir,
      rules: [
        makeFailingProjectRule('broken-tool', counter),
        makeRule('good-rule', [violation('src/a.ts', 'good-rule')]),
      ],
    });

    const result = await Effect.runPromise(runAll(config));

    // Other rules still produce results.
    expect(result.byRule.find((r) => r.ruleId === 'good-rule')?.violations).toHaveLength(1);

    const broken = result.byRule.find((r) => r.ruleId === 'broken-tool');
    expect(broken?.violations).toHaveLength(1);
    expect(broken?.violations[0]?.severity).toBe('error');
    expect(broken?.violations[0]?.message).toContain('unexpected error');
    expect(broken?.violations[0]?.message).toContain('adapter exploded');
    expect(broken?.violations[0]?.fix).toContain('--throw');
    // A failure is critical: it makes the run fail, even without a category.
    expect(result.passing).toBe(false);
    expect(result.failedRules).toEqual(['broken-tool']);
  });

  it('does not cache a failed rule, so the next run retries it', async () => {
    const counter = { calls: 0 };
    const dbPath = nodePath.join(dir, 'cache.db');
    const config = (): ReturnType<typeof defineConfig> =>
      defineConfig({
        projectRoot: dir,
        storage: { kind: 'sqlite', path: dbPath },
        rules: [makeFailingProjectRule('broken-tool', counter)],
      });

    await Effect.runPromise(runAll(config()));
    await Effect.runPromise(runAll(config()));
    await Effect.runPromise(runAll(config()));

    expect(counter.calls).toBe(3);
  });

  it('throws instead when throwOnRuleError is set', async () => {
    const counter = { calls: 0 };
    const config = defineConfig({
      projectRoot: dir,
      rules: [makeFailingProjectRule('broken-tool', counter)],
    });

    await expect(
      Effect.runPromise(runAll(config, { throwOnRuleError: true })),
    ).rejects.toThrow(/adapter exploded/);
  });
});

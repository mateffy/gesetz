import type { RunResult } from '../../src/engine/runner';

export const result = (overrides: Partial<RunResult> = {}): RunResult => ({
  byRule: [
    {
      ruleId: 'rule-a',
      description: 'Rule A',
      category: 'cleanup',
      violations: [
        {
          rule: 'rule-a',
          message: 'bad thing',
          path: 'src/a.ts',
          line: 3,
          column: 5,
          severity: 'error',
          source: 'core',
        },
        {
          rule: 'rule-a',
          message: 'meh thing',
          path: 'src/b.ts',
          severity: 'warn',
          source: 'core',
        },
      ],
    },
    { ruleId: 'rule-b', description: 'Rule B', category: 'structure', violations: [] },
  ],
  byCategory: [],
  totalViolations: 2,
  passing: false,
  ...overrides,
});

import { describe, it, expect } from 'vitest';
import { Effect } from 'effect';
import { TestRunnerReporter, type TestRunnerAPI } from '../../src/reporters/test-runner';
import { Reporter } from '../../src/reporters/reporter';

/** A recorder that stands in for vitest, jest, or bun:test. */
function recorder(): {
  calls: { suites: string[]; cases: string[]; compares: number };
  api: TestRunnerAPI;
} {
  const calls = { suites: [] as string[], cases: [] as string[], compares: 0 };
  return {
    calls,
    api: {
      describe: (name, fn) => {
        calls.suites.push(name);
        fn();
      },
      it: (name, fn) => {
        calls.cases.push(name);
        void fn();
      },
      expect: () => ({
        toEqual: () => {
          calls.compares++;
        },
      }),
    },
  };
}

const report = (api: TestRunnerAPI, r: RunResult) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const reporter = yield* Reporter;
      return yield* reporter.report(r);
    }).pipe(Effect.provide(TestRunnerReporter(api))),
  );

describe('TestRunnerReporter', () => {
  it('wraps everything in one suite', async () => {
    const r = recorder();
    await report(r.api, result());
    expect(r.calls.suites).toEqual(['Quality Assurance']);
  });

  it('declares one case per rule, named by its description', async () => {
    const r = recorder();
    await report(r.api, result());
    expect(r.calls.cases).toEqual(['Rule A', 'Rule B']);
  });

  it('compares against an empty message list, so violations read as failures', async () => {
    const r = recorder();
    await report(r.api, result());
    expect(r.calls.compares).toBe(2);
  });

  it('falls back to the rule id when there is no description', async () => {
    const r = recorder();
    await report(
      r.api,
      result({
        byRule: [{ ruleId: 'rule-x', description: '', category: undefined, violations: [] }],
      }),
    );
    expect(r.calls.cases).toEqual(['rule-x']);
  });
});

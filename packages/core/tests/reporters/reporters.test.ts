import { describe, it, expect } from 'vitest';
import { Effect } from 'effect';
import { TestRunnerReporter } from '../../src/reporters/test-runner';
import { Reporter } from '../../src/reporters/reporter';
import type { RunResult } from '../../src/engine/runner';

function makeResult(overrides?: Partial<RunResult>): RunResult {
  return {
    byRule: [],
    byCategory: [],
    totalViolations: 0,
    passing: true,
    ...overrides,
  };
}

const runReporter = (reporter: ReturnType<typeof TestRunnerReporter>, result: RunResult) =>
  Reporter.pipe(
    Effect.flatMap((r) => r.report(result)),
    Effect.provide(reporter),
    Effect.runPromise,
  );

describe('TestRunnerReporter', () => {
  it('registers a describe block called "Quality Assurance"', async () => {
    const log: string[] = [];
    const mockRunner = {
      describe: (name: string, fn: () => void) => {
        log.push(`describe:${name}`);
        fn();
      },
      it: (name: string, _fn: () => void) => log.push(`it:${name}`),
      expect: (_v: unknown) => ({ toEqual: (_e: unknown) => {} }),
    };

    const reporter = TestRunnerReporter(mockRunner);
    await runReporter(reporter, makeResult());

    expect(log).toContain('describe:Quality Assurance');
  });

  it('registers one it() per rule using the description', async () => {
    const itNames: string[] = [];
    const mockRunner = {
      describe: (_name: string, fn: () => void) => fn(),
      it: (name: string, _fn: () => void) => itNames.push(name),
      expect: (_v: unknown) => ({ toEqual: (_e: unknown) => {} }),
    };

    const result = makeResult({
      byRule: [
        { ruleId: 'rule-1', description: 'All components need stories', category: undefined, violations: [] },
        { ruleId: 'rule-2', description: 'No raw strings in JSX', category: undefined, violations: [] },
      ],
    });

    await runReporter(TestRunnerReporter(mockRunner), result);
    expect(itNames).toEqual(['All components need stories', 'No raw strings in JSX']);
  });

  it('falls back to ruleId when description is empty', async () => {
    const itNames: string[] = [];
    const mockRunner = {
      describe: (_name: string, fn: () => void) => fn(),
      it: (name: string, _fn: () => void) => itNames.push(name),
      expect: (_v: unknown) => ({ toEqual: (_e: unknown) => {} }),
    };

    const result = makeResult({
      byRule: [{ ruleId: 'my-rule', description: '', category: undefined, violations: [] }],
    });

    await runReporter(TestRunnerReporter(mockRunner), result);
    expect(itNames).toEqual(['my-rule']);
  });

  it('passing violations produce expect([]).toEqual([]) call', async () => {
    const equalCalls: unknown[][] = [];
    const mockRunner = {
      describe: (_name: string, fn: () => void) => fn(),
      it: (_name: string, fn: () => void) => fn(),
      expect: (actual: unknown) => ({
        toEqual: (expected: unknown) => {
          equalCalls.push([actual, expected]);
        },
      }),
    };

    const result = makeResult({
      byRule: [{ ruleId: 'r', description: 'R', category: undefined, violations: [] }],
    });

    await runReporter(TestRunnerReporter(mockRunner), result);
    expect(equalCalls).toHaveLength(1);
    expect(equalCalls[0]?.[0]).toEqual([]);
    expect(equalCalls[0]?.[1]).toEqual([]);
  });

  it('violations become non-empty arrays in the expect call', async () => {
    const equalCalls: unknown[][] = [];
    const mockRunner = {
      describe: (_name: string, fn: () => void) => fn(),
      it: (_name: string, fn: () => void) => fn(),
      expect: (actual: unknown) => ({
        toEqual: (expected: unknown) => equalCalls.push([actual, expected]),
      }),
    };

    const result = makeResult({
      byRule: [
        {
          ruleId: 'r',
          description: 'R',
          category: undefined,
          violations: [
            {
              rule: 'r',
              message: 'broken',
              path: 'src/foo.ts',
              line: 5,
              severity: 'error' as const,
              source: 'core' as const,
            },
          ],
        },
      ],
    });

    await runReporter(TestRunnerReporter(mockRunner), result);
    const actual = equalCalls[0]?.[0] as string[];
    expect(actual).toHaveLength(1);
    expect(actual[0]).toContain('src/foo.ts:5');
    expect(actual[0]).toContain('broken');
  });
});

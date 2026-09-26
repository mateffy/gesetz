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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Effect } from 'effect';
import { GitHubActionsReporter } from '../../src/reporters/github-actions';
import { Reporter } from '../../src/reporters/reporter';

let out: string;
beforeEach(() => {
  out = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out += String(chunk);
    return true;
  });
});
afterEach(() => vi.restoreAllMocks());

const report = (r: RunResult) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const reporter = yield* Reporter;
      return yield* reporter.report(r);
    }).pipe(Effect.provide(GitHubActionsReporter)),
  );

describe('GitHubActionsReporter', () => {
  it('emits one workflow command per violation', async () => {
    await report(result());
    expect(out.trim().split(String.fromCharCode(10))).toHaveLength(2);
  });

  it('uses ::error for an error and ::warning for a warn', async () => {
    await report(result());
    expect(out).toContain('::error file=src/a.ts,line=3,col=5::bad thing');
    expect(out).toContain('::warning file=src/b.ts::meh thing');
  });

  it('omits line and column when they are absent', async () => {
    await report(result());
    expect(out).not.toContain('file=src/b.ts,line');
  });

  it('writes nothing when there are no violations', async () => {
    await report(result({ byRule: [], totalViolations: 0, passing: true }));
    expect(out).toBe('');
  });
});

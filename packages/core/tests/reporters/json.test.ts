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
import { JsonReporter } from '../../src/reporters/json';
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
    }).pipe(Effect.provide(JsonReporter)),
  );

describe('JsonReporter', () => {
  it('writes the violations as a JSON array', async () => {
    await report(result());
    const parsed = JSON.parse(out) as { path: string }[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
  });

  it('flattens violations across rules', async () => {
    await report(result());
    expect((JSON.parse(out) as { path: string }[]).map((v) => v.path)).toEqual([
      'src/a.ts',
      'src/b.ts',
    ]);
  });

  it('writes an empty array when there are no violations', async () => {
    await report(result({ byRule: [], totalViolations: 0, passing: true }));
    expect(JSON.parse(out)).toEqual([]);
  });

  it('produces valid JSON, not just JSON-like text', async () => {
    await report(result());
    expect(() => JSON.parse(out)).not.toThrow();
  });
});

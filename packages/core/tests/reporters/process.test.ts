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
import { ProcessReporter } from '../../src/reporters/process';
import { Reporter } from '../../src/reporters/reporter';

let err: string;
beforeEach(() => {
  err = '';
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    err += String(chunk);
    return true;
  });
  process.exitCode = undefined;
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

const report = (r: RunResult) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const reporter = yield* Reporter;
      return yield* reporter.report(r);
    }).pipe(Effect.provide(ProcessReporter)),
  );

describe('ProcessReporter', () => {
  it('writes the banner to stderr so stdout stays a clean data contract', async () => {
    await report(result());
    expect(err).toContain('gesetz: fail (2 violations)');
  });

  it('sets exit code 1 when there are violations', async () => {
    await report(result());
    expect(process.exitCode).toBe(1);
  });

  it('says pass and leaves the exit code alone when clean', async () => {
    await report(result({ byRule: [], totalViolations: 0, passing: true }));
    expect(err).toContain('gesetz: pass (0 violations)');
    expect(process.exitCode).toBeUndefined();
  });

  it('singularises one violation', async () => {
    await report(result({ totalViolations: 1 }));
    expect(err).toContain('(1 violation)');
    expect(err).not.toContain('1 violations');
  });
});

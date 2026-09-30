import { describe, expect, it } from 'vitest';
import { narrowRunResult } from '../../src/engine/aggregate';
import { STALE_RULE_ID } from '../../src/engine/baseline';
import type { RuleResult, RunResult } from '../../src/engine/result';
import type { Violation } from '../../src/engine/rule';

const violation = (path: string, rule = 'r'): Violation => ({
  rule,
  message: 'm',
  path,
  severity: 'error',
  source: 'core',
});

const ruleResult = (
  ruleId: string,
  violations: Violation[],
  category: string | undefined = 'structure',
): RuleResult => ({
  ruleId,
  description: ruleId,
  category,
  violations,
});

const result = (overrides: Partial<RunResult> = {}): RunResult => ({
  byRule: [ruleResult('r', [violation('src/a.ts'), violation('other/b.ts')])],
  byCategory: [],
  totalViolations: 2,
  passing: false,
  ...overrides,
});

const narrowTo = (input: RunResult, fileFilter: readonly string[] | null) =>
  narrowRunResult(input, { fileFilter, changedPaths: null, thresholds: [] });

describe('narrowRunResult', () => {
  it('keeps only the violations inside the scope, and recounts', () => {
    const narrowed = narrowTo(result(), ['src/**']);
    expect(narrowed.byRule[0]?.violations.map((v) => v.path)).toEqual(['src/a.ts']);
    expect(narrowed.totalViolations).toBe(1);
  });

  it('keeps everything when there is no scope to apply', () => {
    const narrowed = narrowTo(result(), null);
    expect(narrowed.totalViolations).toBe(2);
  });

  it('recomputes the stale count for this scope rather than inheriting the tree', () => {
    // The bug this guards: a whole-tree run's stale entries are for the whole tree.
    // Carrying that count to a scoped caller fails it for entries outside its scope.
    // In scope: nothing. Out of scope: the whole tree's stale entry.
    const full = result({
      byRule: [
        ruleResult('r', [], undefined),
        ruleResult(STALE_RULE_ID, [violation('other/gone.ts', STALE_RULE_ID)], undefined),
      ],
      baseline: { new: 0, baselined: 5, stale: 1, total: 6, byRule: [] },
      passing: false,
    });
    const narrowed = narrowTo(full, ['src/**']);
    expect(narrowed.baseline?.new).toBe(0);
    expect(narrowed.baseline?.stale).toBe(0);
    expect(narrowed.passing).toBe(true);
  });

  it('still fails a scoped caller that has its own new violation', () => {
    const full = result({
      byRule: [ruleResult('r', [violation('src/a.ts')], undefined)],
      baseline: { new: 1, baselined: 0, stale: 0, total: 1, byRule: [] },
      passing: false,
    });
    const narrowed = narrowTo(full, ['src/**']);
    expect(narrowed.passing).toBe(false);
  });

  it('keeps a stale entry that is inside the scope', () => {
    const full = result({
      byRule: [
        ruleResult('r', [], undefined),
        ruleResult(STALE_RULE_ID, [violation('src/gone.ts', STALE_RULE_ID)], undefined),
      ],
      baseline: { new: 0, baselined: 0, stale: 1, total: 1, byRule: [] },
      passing: false,
    });
    const narrowed = narrowTo(full, ['src/**']);
    expect(narrowed.baseline?.stale).toBe(1);
    expect(narrowed.passing).toBe(false);
  });

  it('reports the per-rule baseline split for the rules that survive', () => {
    const full = result({
      byRule: [ruleResult('r', [violation('src/a.ts')]), ruleResult('s', [violation('other/b.ts')])],
      baseline: {
        new: 2,
        baselined: 3,
        stale: 0,
        total: 5,
        byRule: [{ rule: 'r', new: 1, baselined: 3, stale: 0 }],
      },
    });
    const narrowed = narrowTo(full, ['src/**']);
    expect(narrowed.baseline?.byRule).toEqual([{ rule: 'r', new: 1, baselined: 3, stale: 0 }]);
  });

  it('applies a --since cut as well as the paths', () => {
    const full = result({
      byRule: [ruleResult('r', [violation('src/a.ts'), violation('src/b.ts')])],
    });
    const narrowed = narrowRunResult(full, {
      fileFilter: ['src/**'],
      changedPaths: new Set(['src/b.ts']),
      thresholds: [],
    });
    expect(narrowed.byRule[0]?.violations.map((v) => v.path)).toEqual(['src/b.ts']);
  });

  it('drops the whole-tree exemption notices, which are about files out of scope', () => {
    const full = result({
      exemptionSuppressions: [{ path: 'other/**', rule: '*', ruleId: 'r', count: 3 }],
    });
    expect(narrowTo(full, ['src/**']).exemptionSuppressions).toEqual([]);
  });

  it('keeps exemptions when nothing was declared', () => {
    expect(narrowTo(result(), ['src/**']).exemptionSuppressions).toBeUndefined();
  });

  it('recomputes category scores from the narrowed violations', () => {
    const full = result({
      byRule: [ruleResult('r', [violation('src/a.ts'), violation('other/b.ts')])],
    });
    const narrowed = narrowRunResult(full, {
      fileFilter: ['src/**'],
      changedPaths: null,
      thresholds: [{ category: 'structure', minScore: 7 }],
    });
    expect(narrowed.byCategory.map((c) => c.category)).toEqual(['structure']);
    expect(narrowed.byCategory[0]?.totalViolations).toBe(1);
  });
});

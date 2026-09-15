import { describe, expect, it } from 'vitest';
import { computeCategoryScores } from '../../src/engine/result';
import type { RuleResult } from '../../src/engine/result';
import type { Severity } from '../../src/engine/rule';

const violation = (severity: Severity) => ({
  message: 'x',
  path: 'src/a.ts',
  severity,
  source: 'core' as const,
});

function result(
  category: string | undefined,
  severities: readonly Severity[],
  ruleId = 'r',
): RuleResult {
  return {
    ruleId,
    description: ruleId,
    category,
    violations: severities.map((severity) => violation(severity)),
  };
}

describe('computeCategoryScores', () => {
  it('returns nothing when no rule has a category', () => {
    expect(computeCategoryScores([result(undefined, ['error'])], [])).toEqual([]);
  });

  it('scores a clean category at 10', () => {
    const [score] = computeCategoryScores([result('cleanup', [])], []);
    expect(score?.score).toBe(10);
    expect(score?.passing).toBe(true);
    expect(score?.totalViolations).toBe(0);
  });

  it('weights errors 1.0, warnings 0.5 and infos 0.1', () => {
    const byCategory = (severities: readonly Severity[]): number | undefined =>
      computeCategoryScores([result('c', severities)], [])[0]?.score;

    expect(byCategory(['error'])).toBe(9);
    expect(byCategory(['error', 'error'])).toBe(8);
    expect(byCategory(['warn'])).toBe(9.5);
    expect(byCategory(['info', 'info'])).toBe(9.8);
    expect(byCategory(['error', 'warn', 'info'])).toBe(8.4);
  });

  it('never goes below zero', () => {
    const severities = Array.from({ length: 20 }, () => 'error' as const);
    expect(computeCategoryScores([result('c', severities)], [])[0]?.score).toBe(0);
  });

  it('applies the configured threshold, defaulting to 7', () => {
    const severities = Array.from({ length: 3 }, () => 'error' as const); // score 7
    expect(computeCategoryScores([result('c', severities)], [])[0]?.passing).toBe(true);
    expect(
      computeCategoryScores([result('c', severities)], [{ category: 'c', minScore: 8 }])[0]?.passing,
    ).toBe(false);
    expect(
      computeCategoryScores([result('c', severities)], [{ category: 'c', minScore: 7 }])[0]?.passing,
    ).toBe(true);
  });

  it('aggregates several rules in one category', () => {
    const [score] = computeCategoryScores(
      [result('c', ['error'], 'a'), result('c', ['warn'], 'b'), result('c', [], 'c')],
      [],
    );
    expect(score?.errors).toBe(1);
    expect(score?.warnings).toBe(1);
    expect(score?.totalViolations).toBe(2);
    expect(score?.ruleIds).toEqual(['a', 'b', 'c']);
    expect(score?.score).toBe(8.5);
  });

  it('keeps categories independent', () => {
    const scores = computeCategoryScores([result('a', ['error']), result('b', [])], []);
    expect(scores.map((s) => [s.category, s.score])).toEqual([
      ['a', 9],
      ['b', 10],
    ]);
  });
});

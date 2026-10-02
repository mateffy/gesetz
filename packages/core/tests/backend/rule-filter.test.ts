import { describe, expect, it } from 'vitest';
import { filterRules } from '../../src/backend/rule-filter';

const rule = (id: string) => ({ id, description: id, run: null }) as never;

describe('filterRules', () => {
  const rules = [rule('no-god-files'), rule('no-empty-catch'), rule('tsc'), rule('vitest')];

  it('keeps only the named rules', () => {
    expect(filterRules(rules, ['tsc']).map((r) => r.id)).toEqual(['tsc']);
  });

  it('accepts globs, so a family is one flag', () => {
    expect(filterRules(rules, ['no-*']).map((r) => r.id)).toEqual([
      'no-god-files',
      'no-empty-catch',
    ]);
  });

  it('keeps several names, and keeps them in config order', () => {
    expect(filterRules(rules, ['vitest', 'tsc']).map((r) => r.id)).toEqual(['tsc', 'vitest']);
  });

  it('throws for a filter that matches nothing, naming what it tried', () => {
    // Silent no-match is how an agent believes it checked something. The rule ids that
    // exist are listed so the mistake is one line long.
    expect(() => filterRules(rules, ['typo'])).toThrowError(/no rule matches 'typo'.*tsc/s);
  });

  it('passes every rule through when the filter is null', () => {
    expect(filterRules(rules, null)).toHaveLength(4);
  });

  it('does not mutate the list it was given', () => {
    const input = [...rules];
    filterRules(input, ['tsc']);
    expect(input).toHaveLength(4);
  });
});

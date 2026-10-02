import { describe, it, expect } from 'vitest';
import type { CategoryThreshold, Rule } from '@gesetz/core';
import { parseFileRequest, resolveCheckScope } from '../src/check';

const rule = (id: string, category: string | undefined): Rule =>
  ({ id, description: id, category }) as Rule;

const RULES: Rule[] = [
  rule('no-console-log', 'cleanup'),
  rule('no-magic-numbers', 'cleanup'),
  rule('require-strict-types', 'strictness'),
  rule('no-category-rule', undefined),
];

const THRESHOLDS: CategoryThreshold[] = [
  { category: 'cleanup', minScore: 7 },
  { category: 'strictness', minScore: 10 },
];

describe('resolveCheckScope: --rule composes with --category', () => {
  const rule = (id: string, category: string) =>
    ({ id, description: id, category, run: null }) as never;

  const rules = [
    rule('no-god-files', 'cleanup'),
    rule('no-empty-catch-blocks', 'cleanup'),
    rule('tsc', 'correctness'),
  ];

  const resolve = (ruleFilter: readonly string[] | null) =>
    resolveCheckScope({
      rules,
      configuredThresholds: [],
      categoryFilter: undefined,
      ruleFilter,
      thresholdOverride: undefined,
    });

  it('narrows to one rule', () => {
    expect(resolve(['tsc']).rules.map((r) => r.id)).toEqual(['tsc']);
  });

  it('is an intersection, not a union, when both filters are given', () => {
    // `--category cleanup --rule tsc` asks for the type checker *within* the cleanup
    // category, which is nothing. Answering with `tsc` would silently ignore one of
    // the two filters, and answering with all of cleanup would ignore the other.
    const scoped = () =>
      resolveCheckScope({
        rules,
        configuredThresholds: [],
        categoryFilter: 'cleanup',
        ruleFilter: ['tsc'],
        thresholdOverride: undefined,
      });
    expect(scoped).toThrowError(/no rule matches 'tsc'/);
  });

  it('keeps both filters when they do intersect', () => {
    const scoped = resolveCheckScope({
      rules,
      configuredThresholds: [],
      categoryFilter: 'cleanup',
      ruleFilter: ['no-*'],
      thresholdOverride: undefined,
    });
    expect(scoped.rules.map((r) => r.id)).toEqual(['no-god-files', 'no-empty-catch-blocks']);
  });
});

describe('resolveCheckScope', () => {
  it('keeps every rule and the configured thresholds when nothing is narrowed', () => {
    const scope = resolveCheckScope({
      rules: RULES,
      configuredThresholds: THRESHOLDS,
      categoryFilter: undefined,
      thresholdOverride: undefined,
    });
    expect(scope.rules.map((r) => r.id)).toEqual(RULES.map((r) => r.id));
    expect(scope.thresholds).toEqual(THRESHOLDS);
  });

  it('keeps only the requested categories', () => {
    const scope = resolveCheckScope({
      rules: RULES,
      configuredThresholds: THRESHOLDS,
      categoryFilter: 'cleanup',
      thresholdOverride: undefined,
    });
    expect(scope.rules.map((r) => r.id)).toEqual(['no-console-log', 'no-magic-numbers']);
  });

  it('accepts several categories, with spaces', () => {
    const scope = resolveCheckScope({
      rules: RULES,
      configuredThresholds: THRESHOLDS,
      categoryFilter: 'cleanup, strictness',
      thresholdOverride: undefined,
    });
    expect(scope.rules.map((r) => r.id)).toEqual([
      'no-console-log',
      'no-magic-numbers',
      'require-strict-types',
    ]);
  });

  it('never selects a rule with no category', () => {
    const scope = resolveCheckScope({
      rules: RULES,
      configuredThresholds: THRESHOLDS,
      categoryFilter: 'cleanup,strictness',
      thresholdOverride: undefined,
    });
    expect(scope.rules.map((r) => r.id)).not.toContain('no-category-rule');
  });

  it('leaves the configured thresholds alone when only filtering', () => {
    const scope = resolveCheckScope({
      rules: RULES,
      configuredThresholds: THRESHOLDS,
      categoryFilter: 'cleanup',
      thresholdOverride: undefined,
    });
    expect(scope.thresholds).toEqual(THRESHOLDS);
  });

  it('replaces the thresholds for the categories that will run', () => {
    const scope = resolveCheckScope({
      rules: RULES,
      configuredThresholds: THRESHOLDS,
      categoryFilter: undefined,
      thresholdOverride: 3,
    });
    expect(scope.thresholds).toEqual([
      { category: 'cleanup', minScore: 3 },
      { category: 'strictness', minScore: 3 },
    ]);
  });

  it('applies the override only to the filtered categories', () => {
    // `--category strictness --threshold 3` scores strictness against 3 and says
    // nothing about cleanup.
    const scope = resolveCheckScope({
      rules: RULES,
      configuredThresholds: THRESHOLDS,
      categoryFilter: 'strictness',
      thresholdOverride: 3,
    });
    expect(scope.thresholds).toEqual([{ category: 'strictness', minScore: 3 }]);
  });

  it('produces no thresholds when a filter matches nothing', () => {
    const scope = resolveCheckScope({
      rules: RULES,
      configuredThresholds: THRESHOLDS,
      categoryFilter: 'no-such-category',
      thresholdOverride: 5,
    });
    expect(scope.rules).toEqual([]);
    expect(scope.thresholds).toEqual([]);
  });

  it('ignores empty entries in the category list', () => {
    const scope = resolveCheckScope({
      rules: RULES,
      configuredThresholds: THRESHOLDS,
      categoryFilter: 'cleanup,,  ,',
      thresholdOverride: undefined,
    });
    expect(scope.rules.map((r) => r.id)).toEqual(['no-console-log', 'no-magic-numbers']);
  });

  it('does not mutate the rules it is given', () => {
    const scope = resolveCheckScope({
      rules: RULES,
      configuredThresholds: THRESHOLDS,
      categoryFilter: 'cleanup',
      thresholdOverride: 1,
    });
    scope.rules.push(rule('added-by-the-caller', 'cleanup'));
    expect(RULES).toHaveLength(4);
  });
});

describe('parseFileRequest', () => {
  it('accepts one path', () => {
    expect(parseFileRequest(['src/a.ts'])).toEqual(['src/a.ts']);
  });

  it('accepts a comma-separated list', () => {
    expect(parseFileRequest(['src/a.ts,src/b.ts,app/M.php'])).toEqual([
      'src/a.ts',
      'src/b.ts',
      'app/M.php',
    ]);
  });

  it('accepts a repeated flag', () => {
    // `--files a.ts --files b.ts` is the same request as the comma-separated form.
    expect(parseFileRequest(['src/a.ts', 'src/b.ts'])).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('combines both spellings', () => {
    expect(parseFileRequest(['src/a.ts,src/b.ts', 'src/c.ts'])).toEqual([
      'src/a.ts',
      'src/b.ts',
      'src/c.ts',
    ]);
  });

  it('trims whitespace around entries', () => {
    expect(parseFileRequest([' src/a.ts , src/b.ts '])).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('ignores empty entries', () => {
    expect(parseFileRequest(['src/a.ts,,  ,'])).toEqual(['src/a.ts']);
  });

  it('returns null when nothing was asked for, meaning the whole project', () => {
    // Null and [] are different answers: [] would mean "no files", which would
    // make an empty flag value look like a clean run.
    expect(parseFileRequest([])).toBeNull();
    expect(parseFileRequest(['', '   '])).toBeNull();
  });

  it('keeps glob patterns as they were written', () => {
    expect(parseFileRequest(['src/**/*.tsx'])).toEqual(['src/**/*.tsx']);
  });
});

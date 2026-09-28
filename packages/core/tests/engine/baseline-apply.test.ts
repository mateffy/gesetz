import { describe, it, expect } from 'vitest';
import { partitionByBaseline, planBaselineWrite } from '../../src/engine/baseline-apply';
import {
  BASELINE_FILE_VERSION,
  STALE_RULE_ID,
  violationHash,
  type BaselineFile,
  type BaselineViolationGroup,
} from '../../src/engine/baseline';
import type { Violation } from '../../src/engine/rule';

const RULE = 'no-console-log';

const violation = (message = 'no console.log', path = 'src/a.ts'): Violation => ({
  rule: RULE,
  path,
  message,
  severity: 'error',
  source: 'core',
  line: 1,
});

const entry = (message = 'no console.log', path = 'src/a.ts', count = 1) => ({
  rule: RULE,
  hash: violationHash(RULE, path, message),
  message,
  count,
  line: 1,
});

const baseline = (entries: BaselineFile['entries'] = {}, total = 1): BaselineFile => ({
  version: BASELINE_FILE_VERSION,
  gesetz: '0.0.0',
  total,
  entries,
});

const group = (violations: Violation[] = [violation()]): BaselineViolationGroup => ({
  rule: RULE,
  violations,
});

describe('partitionByBaseline', () => {
  it('treats a matching violation as already baselined, not as new', () => {
    const result = partitionByBaseline([group()], baseline({ 'src/a.ts': [entry()] }));
    expect(result.stats.baselined).toBe(1);
    expect(result.stats.new).toBe(0);
    expect(result.newByRule.get(RULE)).toEqual([]);
  });

  it('reports a violation the baseline does not cover as new', () => {
    const result = partitionByBaseline(
      [group([violation('a different message')])],
      baseline({ 'src/a.ts': [entry()] }),
    );
    expect(result.stats.new).toBe(1);
    expect(result.newByRule.get(RULE)).toHaveLength(1);
  });

  it('reports an entry with no matching violation as stale', () => {
    const result = partitionByBaseline([group([])], baseline({ 'src/a.ts': [entry()] }));
    expect(result.stats.stale).toBe(1);
    expect(result.stale[0]?.rule).toBe(STALE_RULE_ID);
  });

  it('consumes one baseline entry per violation, so a count of two covers two', () => {
    const two = [violation(), violation()];
    const result = partitionByBaseline(
      [group(two)],
      baseline({ 'src/a.ts': [entry('no console.log', 'src/a.ts', 2)] }),
    );
    expect(result.stats.baselined).toBe(2);
    expect(result.stats.new).toBe(0);
    expect(result.stats.stale).toBe(0);
  });

  it('reports the surplus as new when the violations outnumber the baseline', () => {
    const three = [violation(), violation(), violation()];
    const result = partitionByBaseline(
      [group(three)],
      baseline({ 'src/a.ts': [entry('no console.log', 'src/a.ts', 2)] }),
    );
    expect(result.stats.baselined).toBe(2);
    expect(result.stats.new).toBe(1);
  });

  it('reports the surplus as stale when the baseline outnumbers the violations', () => {
    const result = partitionByBaseline(
      [group([violation()])],
      baseline({ 'src/a.ts': [entry('no console.log', 'src/a.ts', 3)] }),
    );
    expect(result.stats.baselined).toBe(1);
    expect(result.stats.stale).toBe(1);
    expect(result.stale[0]?.message).toContain('2');
  });

  it('ignores a stale entry outside the examined scope', () => {
    // A --since run cannot see files it did not examine, so their entries are
    // not stale; they are simply not in play.
    const result = partitionByBaseline([group([])], baseline({ 'src/a.ts': [entry()] }), {
      inScope: () => false,
    });
    expect(result.stats.stale).toBe(0);
  });

  it('suppresses a stale entry the caller vetoes', () => {
    const result = partitionByBaseline([group([])], baseline({ 'src/a.ts': [entry()] }), {
      allowStale: () => false,
    });
    expect(result.stats.stale).toBe(0);
  });

  it('counts per rule and sorts the rule list', () => {
    const groups: BaselineViolationGroup[] = [
      { rule: 'zzz', violations: [{ ...violation(), rule: 'zzz' }] },
      { rule: 'aaa', violations: [{ ...violation(), rule: 'aaa' }] },
    ];
    const result = partitionByBaseline(groups, baseline({}, 0));
    expect(result.stats.byRule.map((r) => r.rule)).toEqual(['aaa', 'zzz']);
  });

  it('omits rules with nothing to report', () => {
    const result = partitionByBaseline([group([])], baseline({}, 0));
    expect(result.stats.byRule).toEqual([]);
  });

  it('carries the baseline total through, so a report can say how much it started from', () => {
    expect(partitionByBaseline([group()], baseline({ 'src/a.ts': [entry()] })).stats.total).toBe(1);
  });

  it('treats every violation as new against an empty baseline', () => {
    const result = partitionByBaseline([group([violation(), violation()])], baseline({}, 0));
    expect(result.stats.new).toBe(2);
    expect(result.stats.stale).toBe(0);
  });

  it('matches on the normalized message by default, so a digit change is the same violation', () => {
    const shifted = violation('expected 5 to be 2');
    const stored = {
      ...entry(),
      message: 'expected 1 to be 2',
      hash: violationHash(RULE, 'src/a.ts', 'expected 1 to be 2'),
    };
    const result = partitionByBaseline([group([shifted])], baseline({ 'src/a.ts': [stored] }));
    expect(result.stats.baselined).toBe(1);
  });

  it('matches on the exact message when the rule asks for it', () => {
    const shifted = violation('expected 5 to be 2');
    const stored = {
      ...entry(),
      message: 'expected 1 to be 2',
      hash: violationHash(RULE, 'src/a.ts', 'expected 1 to be 2'),
    };
    const result = partitionByBaseline([group([shifted])], baseline({ 'src/a.ts': [stored] }), {
      modes: new Map([[RULE, 'exact']]),
    });
    expect(result.stats.new).toBe(1);
  });

  it('does not care about the line, so an import at the top does not invalidate a baseline', () => {
    const moved = { ...violation(), line: 42 };
    const result = partitionByBaseline([group([moved])], baseline({ 'src/a.ts': [entry()] }));
    expect(result.stats.baselined).toBe(1);
  });
});

describe('planBaselineWrite', () => {
  const options = { gesetzVersion: '1.0.0' };

  it('accepts the whole backlog on a first write', () => {
    const plan = planBaselineWrite(baseline({ 'src/a.ts': [entry()] }), null, options);
    expect(plan.refused).toEqual([]);
    expect(plan.added).toBe(1);
  });

  it('refuses to absorb a violation the existing baseline does not cover', () => {
    const plan = planBaselineWrite(
      baseline({ 'src/a.ts': [entry()], 'src/b.ts': [entry('brand new problem', 'src/b.ts')] }),
      baseline({ 'src/a.ts': [entry()] }),
      options,
    );
    expect(plan.refused).toHaveLength(1);
    expect(plan.refused[0]?.path).toBe('src/b.ts');
    expect(plan.refused[0]?.count).toBe(1);
  });

  it('accepts a violation whose rule was explicitly named', () => {
    // The day a new rule lands, its backlog is accepted on purpose rather than
    // smuggled in by a blanket write.
    const plan = planBaselineWrite(
      baseline({ 'src/a.ts': [entry(), entry('brand new problem', 'src/b.ts')] }),
      baseline({ 'src/a.ts': [entry()] }),
      { ...options, rules: [RULE] },
    );
    expect(plan.refused).toEqual([]);
  });

  it('does not refuse anything when the current baseline is unchanged', () => {
    const plan = planBaselineWrite(
      baseline({ 'src/a.ts': [entry()] }),
      baseline({ 'src/a.ts': [entry()] }),
      options,
    );
    expect(plan.refused).toEqual([]);
    expect(plan.added).toBe(0);
    expect(plan.removed).toBe(0);
    expect(plan.kept).toBe(1);
  });

  it('drops an entry that no longer has a violation, and counts it as removed', () => {
    const plan = planBaselineWrite(baseline({}, 0), baseline({ 'src/a.ts': [entry()] }), options);
    expect(plan.removed).toBe(1);
    expect(plan.next.entries).toEqual({});
  });

  it('counts a growing duplicate as an addition', () => {
    const plan = planBaselineWrite(
      baseline({ 'src/a.ts': [entry('no console.log', 'src/a.ts', 3)] }),
      baseline({ 'src/a.ts': [entry('no console.log', 'src/a.ts', 1)] }),
      options,
    );
    expect(plan.added).toBe(2);
    expect(plan.refused).toHaveLength(1);
    expect(plan.refused[0]?.count).toBe(2);
  });

  it('reports a per-rule delta', () => {
    const plan = planBaselineWrite(baseline({ 'src/a.ts': [entry()] }), null, options);
    expect(plan.deltas).toEqual([{ rule: RULE, added: 1, removed: 0, kept: 0 }]);
  });

  it('stamps the gesetz version into the file it produces', () => {
    expect(planBaselineWrite(baseline({ 'src/a.ts': [entry()] }), null, options).next.gesetz).toBe(
      '1.0.0',
    );
  });

  it('keeps entries of rules the explicit write did not name', () => {
    const other = {
      rule: 'other-rule',
      hash: violationHash('other-rule', 'src/a.ts', 'm'),
      message: 'm',
      count: 1,
    };
    const plan = planBaselineWrite(
      baseline({ 'src/a.ts': [entry()] }),
      baseline({ 'src/a.ts': [entry(), other] }),
      { ...options, rules: [RULE] },
    );
    // The named rule's entries are rewritten; the unnamed rule's are carried over.
    const rules = plan.next.entries['src/a.ts']?.map((e) => e.rule) ?? [];
    expect(new Set(rules)).toEqual(new Set([RULE, 'other-rule']));
    expect(plan.kept).toBe(2);
    expect(plan.removed).toBe(0);
  });

  it('treats an empty rule list as no filter rather than as "nothing"', () => {
    const plan = planBaselineWrite(
      baseline({ 'src/a.ts': [entry()] }),
      baseline({ 'src/a.ts': [entry()] }),
      {
        ...options,
        rules: [],
      },
    );
    expect(plan.refused).toEqual([]);
    expect(plan.kept).toBe(1);
  });
});

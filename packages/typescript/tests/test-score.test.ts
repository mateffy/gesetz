import { describe, it, expect } from 'vitest';
import { makeFile, makeCheckServices, runCheck } from '@gesetz/core';
import { requireMinTestScore } from '../src';

const NL = String.fromCharCode(10);

const run = (source: string, minScore: number) =>
  runCheck(
    requireMinTestScore({ minScore }),
    makeFile('src/foo.test.ts', source),
    makeCheckServices(),
  );

/** The score is only observable through the violation message. */
const scoreOf = async (source: string): Promise<number> => {
  const violations = await run(source, 200);
  const message = violations[0]?.message ?? '';
  return Number(/(\d+)/.exec(message)?.[1] ?? NaN);
};

const case_ = (name: string, body: string) => `it('${name}', () => { ${body} });`;

/** Many cases, many assertions, varied matchers, an error path. */
const RICH = [
  case_('a', 'expect(1).toBe(1);'),
  case_('b', 'expect(2).toEqual(2);'),
  case_('c', 'expect(3).toStrictEqual(3);'),
  case_('d', 'expect(() => f()).toThrow();'),
  case_('e', 'expect(4).toBe(4); expect(5).toBe(5);'),
  case_('f', 'expect(6).toBe(6);'),
  case_('g', 'expect(7).toBe(7);'),
  case_('h', 'expect(8).toBe(8);'),
  case_('i', 'expect(9).not.toBe(10);'),
].join(NL);

/** One case, one trivial assertion. */
const POOR = case_('a', 'expect(1).toBeDefined();');

describe('requireMinTestScore', () => {
  it('flags a test file below the minimum', async () => {
    const violations = await run(POOR, 60);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.severity).toBe('warn');
  });

  it('names both the score reached and the score required', async () => {
    const violations = await run(POOR, 60);
    expect(violations[0]?.message).toContain(String(await scoreOf(POOR)));
    expect(violations[0]?.message).toContain('60');
  });

  it('accepts a rich test file at a demanding threshold', async () => {
    expect(await run(RICH, 80)).toHaveLength(0);
  });

  it('accepts anything when the minimum is zero', async () => {
    expect(await run(POOR, 0)).toHaveLength(0);
  });

  it('accepts anything at a minimum at or below the base score', async () => {
    // Even an empty file gets the base score of 40 for "having tests".
    expect(await run('', 40)).toHaveLength(0);
  });

  it('scores a richer file above a poorer one', async () => {
    expect(await scoreOf(RICH)).toBeGreaterThan(await scoreOf(POOR));
  });

  it('penalises trivial-only assertions', async () => {
    const real = case_('a', 'expect(1).toBe(1);');
    const trivial = case_('a', 'expect(1).toBeTruthy();');
    expect(await scoreOf(trivial)).toBeLessThan(await scoreOf(real));
  });

  it('rewards a variety of matchers over the same count of one matcher', async () => {
    const varied = [
      case_('a', 'expect(1).toBe(1);'),
      case_('b', 'expect(2).toEqual(2);'),
      case_('c', 'expect(3).toStrictEqual(3);'),
    ].join(NL);
    const same = [
      case_('a', 'expect(1).toBe(1);'),
      case_('b', 'expect(2).toBe(2);'),
      case_('c', 'expect(3).toBe(3);'),
    ].join(NL);
    expect(await scoreOf(varied)).toBeGreaterThan(await scoreOf(same));
  });

  it('rewards an error path', async () => {
    const withThrow = [
      case_('a', 'expect(1).toBe(1);'),
      case_('b', 'expect(() => f()).toThrow();'),
    ].join(NL);
    const without = [case_('a', 'expect(1).toBe(1);'), case_('b', 'expect(2).toBe(2);')].join(NL);
    expect(await scoreOf(withThrow)).toBeGreaterThan(await scoreOf(without));
  });

  it('counts test( as well as it( as a case', async () => {
    const withTest = "test('a', () => { expect(1).toBe(1); });";
    expect(await scoreOf(withTest)).toBe(await scoreOf(case_('a', 'expect(1).toBe(1);')));
  });

  it('never reports a passing file, however low the score', async () => {
    // The check is a threshold, not a linter: below the minimum it reports once,
    // and it reports nothing when the file clears the bar.
    expect(await run('', 0)).toEqual([]);
  });

  it('uses a custom threshold list when given one', async () => {
    const check = requireMinTestScore({
      minScore: 200,
      assertionThresholds: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    });
    const violations = await runCheck(
      check,
      makeFile('src/foo.test.ts', RICH),
      makeCheckServices(),
    );
    expect(violations).toHaveLength(1);
  });

  it('reports nothing for a file that is not a test at all when the bar is low', async () => {
    expect(await run('export const x = 1;', 40)).toHaveLength(0);
  });
});

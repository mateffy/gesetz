import { describe, it, expect, afterEach } from 'vitest';
import {
  buildEnvelope,
  formatEnvelope,
  formatViolations,
  formatCi,
  formatStatusBanner,
  detectFormat,
  MAX_VIOLATIONS,
} from '../src/format';
import type { RunResult, RuleResult, Violation } from '@regeln/core';

function v(over: Partial<Violation> = {}): Violation {
  return {
    rule: 'r',
    message: 'msg',
    path: 'a.ts',
    severity: 'info',
    source: 'core',
    ...over,
  };
}

function ruleResult(over: Partial<RuleResult> = {}): RuleResult {
  return { ruleId: 'r', description: 'desc', category: 'c', violations: [], ...over };
}

function passingResult(): RunResult {
  return { byRule: [], byCategory: [], totalViolations: 0, passing: true };
}

function failingResult(violations: Violation[]): RunResult {
  const byRule = [ruleResult({ violations })];
  return {
    byRule,
    byCategory: [
      {
        category: 'c',
        score: 5,
        errors: 0,
        warnings: 0,
        infos: violations.length,
        totalViolations: violations.length,
        ruleIds: ['r'],
        passing: false,
      },
    ],
    totalViolations: violations.length,
    passing: false,
  };
}

describe('buildEnvelope', () => {
  it('marks a passing run with status=pass and empty violations', () => {
    const env = buildEnvelope(passingResult());
    expect(env.status).toBe('pass');
    expect(env.passing).toBe(true);
    expect(env.total).toBe(0);
    expect(env.violations).toEqual([]);
    expect(env.truncated).toBe(0);
    expect(env.hint).toBeNull();
    expect(env.summary).toEqual({});
    expect(env.categories).toEqual([]);
  });

  it('flattens violations with stable short keys and the sev enum', () => {
    const env = buildEnvelope(
      failingResult([
        v({ severity: 'error', line: 10, column: 3, message: 'boom' }),
        v({ severity: 'warn', path: 'b.ts', line: 5 }),
      ]),
    );
    expect(env.violations).toHaveLength(2);
    expect(env.violations[0]).toEqual({
      sev: 'error',
      rule: 'r',
      path: 'a.ts',
      line: 10,
      col: 3,
      msg: 'boom',
    });
    expect(env.violations[1]).toEqual({
      sev: 'warn',
      rule: 'r',
      path: 'b.ts',
      line: 5,
      col: null,
      msg: 'msg',
    });
  });

  it('uses col:null (not omitted) when a violation has no column', () => {
    const env = buildEnvelope(failingResult([v({ line: 1 })]));
    expect(env.violations[0].col).toBeNull();
  });

  it('uses line:null when a violation has no line', () => {
    const env = buildEnvelope(failingResult([v({ line: undefined })]));
    expect(env.violations[0].line).toBeNull();
  });

  it('omits rules with zero violations', () => {
    const result: RunResult = {
      byRule: [
        ruleResult({ ruleId: 'empty', violations: [] }),
        ruleResult({ ruleId: 'has', violations: [v()] }),
      ],
      byCategory: [],
      totalViolations: 1,
      passing: false,
    };
    const env = buildEnvelope(result);
    expect(env.violations.every((x) => x.rule === 'has')).toBe(true);
    expect(env.violations).toHaveLength(1);
  });

  it('caps violations at MAX_VIOLATIONS and sets truncated + hint', () => {
    const many = Array.from({ length: MAX_VIOLATIONS + 10 }, (_, i) =>
      v({ line: i + 1, message: 'm' + i }),
    );
    const env = buildEnvelope(failingResult(many));
    expect(env.violations).toHaveLength(MAX_VIOLATIONS);
    expect(env.truncated).toBe(10);
    expect(env.hint).toBe('regel check --format=json --all');
    expect(env.total).toBe(MAX_VIOLATIONS + 10);
  });

  it('--all disables the cap', () => {
    const many = Array.from({ length: MAX_VIOLATIONS + 5 }, (_, i) => v({ line: i + 1 }));
    const env = buildEnvelope(failingResult(many), { all: true });
    expect(env.violations).toHaveLength(MAX_VIOLATIONS + 5);
    expect(env.truncated).toBe(0);
    expect(env.hint).toBeNull();
  });

  it('builds summary as a {category: score} map', () => {
    const env = buildEnvelope(failingResult([v()]));
    expect(env.summary).toEqual({ c: 5 });
  });

  it('includes threshold per category (default 7)', () => {
    const env = buildEnvelope(failingResult([v()]));
    expect(env.categories[0].threshold).toBe(7);
    const env2 = buildEnvelope(failingResult([v()]), { thresholds: { c: 9 } });
    expect(env2.categories[0].threshold).toBe(9);
  });

  it('formatEnvelope emits a single JSON line + trailing newline', () => {
    const out = formatEnvelope(passingResult());
    expect(out.endsWith('\n')).toBe(true);
    const lines = out.replace(/\n$/, '').split('\n');
    expect(lines).toHaveLength(1);
    expect(() => JSON.parse(out)).not.toThrow();
  });
});

describe('formatViolations (pretty, file-grouped)', () => {
  it('groups by file path and sorts lines numerically within a file', () => {
    const result: RunResult = {
      byRule: [
        ruleResult({
          ruleId: 'rule-a',
          violations: [
            v({ path: 'b.ts', line: 50 }),
            v({ path: 'a.ts', line: 30 }),
            v({ path: 'a.ts', line: 10 }),
          ],
        }),
      ],
      byCategory: [],
      totalViolations: 3,
      passing: false,
    };
    const out = formatViolations(result.byRule);
    const aIdx = out.indexOf('a.ts');
    const bIdx = out.indexOf('b.ts');
    expect(aIdx).toBeLessThan(bIdx);
    // line 10 should appear before line 30 within a.ts
    const l10 = out.indexOf('L10');
    const l30 = out.indexOf('L30');
    expect(l10).toBeGreaterThan(aIdx);
    expect(l10).toBeLessThan(l30);
    expect(l30).toBeLessThan(bIdx);
  });

  it('returns empty string when there are no violations', () => {
    expect(formatViolations([ruleResult({ violations: [] })])).toBe('');
  });
});

describe('formatCi', () => {
  it('emits one GitHub Actions line per violation with the rule id', () => {
    const result = failingResult([
      v({ severity: 'error', path: 'a.ts', line: 3, column: 5, message: 'boom' }),
      v({ severity: 'warn', path: 'b.ts', line: 9, message: 'eh' }),
      v({ severity: 'info', path: 'c.ts', line: 1, message: 'note' }),
    ]);
    const out = formatCi(result);
    const lines = out.trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('::error file=a.ts,line=3,col=5::boom [r]');
    expect(lines[1]).toBe('::warning file=b.ts,line=9::eh [r]');
    expect(lines[2]).toBe('::notice file=c.ts,line=1::note [r]');
  });

  it('omits line/col when absent', () => {
    const result = failingResult([v({ line: undefined, column: undefined, message: 'm' })]);
    expect(formatCi(result).trim()).toBe('::notice file=a.ts::m [r]');
  });
});

describe('formatStatusBanner', () => {
  it('writes a one-line verdict to stderr format', () => {
    expect(formatStatusBanner({ ...passingResult(), totalViolations: 0 })).toBe('regel: pass (0 violations)\n');
    expect(formatStatusBanner({ ...failingResult([v()]), totalViolations: 1 })).toBe('regel: fail (1 violation)\n');
    expect(formatStatusBanner({ ...failingResult([v(), v()]), totalViolations: 2 })).toBe('regel: fail (2 violations)\n');
  });
});

describe('detectFormat', () => {
  const origIsTty = process.stdout.isTTY;

  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', { value: origIsTty, configurable: true });
  });

  it('honours an explicit format over auto-detection', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    expect(detectFormat('pretty')).toBe('pretty');
    expect(detectFormat('ci')).toBe('ci');
  });

  it('auto-selects json when stdout is not a TTY', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    expect(detectFormat(undefined)).toBe('json');
  });

  it('auto-selects json when an agent env var is set', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    process.env.CLAUDE_CODE = '1';
    try {
      expect(detectFormat(undefined)).toBe('json');
    } finally {
      delete process.env.CLAUDE_CODE;
    }
  });

  it('defaults to pretty when a TTY and no agent env', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    expect(detectFormat(undefined)).toBe('pretty');
  });
});

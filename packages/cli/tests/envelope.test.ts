import { describe, expect, it } from 'vitest';
import { buildEnvelope, formatEnvelope } from '../src/envelope';
import type { RunResult } from '@gesetz/core';

function passingResult(): RunResult {
  return { byRule: [], byCategory: [], totalViolations: 0, passing: true };
}

function baselinedResult(): RunResult {
  return {
    byRule: [],
    byCategory: [],
    totalViolations: 2,
    passing: false,
    baseline: {
      new: 1,
      baselined: 412,
      stale: 1,
      total: 413,
      byRule: [{ rule: 'r', new: 1, baselined: 412, stale: 1 }],
    },
  };
}

describe('buildEnvelope baseline split', () => {
  it('adds the split without renaming existing fields', () => {
    const env = buildEnvelope(baselinedResult());
    expect(env.total).toBe(2);
    expect(env.violations).toEqual([]);
    expect(env.baseline).toEqual({
      new: 1,
      baselined: 412,
      stale: 1,
      total: 413,
      byRule: [{ rule: 'r', new: 1, baselined: 412, stale: 1 }],
    });
  });

  it('reports null baseline when the run used none', () => {
    expect(buildEnvelope(passingResult()).baseline).toBeNull();
  });

  it('renders the envelope as one JSON line', () => {
    const rendered = formatEnvelope(baselinedResult());
    expect(rendered.endsWith('\n')).toBe(true);
    expect(JSON.parse(rendered).baseline.new).toBe(1);
  });
});

describe('coordination', () => {
  it('carries the coordination block when one is passed', () => {
    const envelope = formatEnvelope(baselinedResult(), {
      coordination: {
        mode: 'reused',
        waitedMs: 3400,
        runAgeMs: 2100,
        listeners: 2,
        recheckedFiles: 4,
        pid: 57132,
      },
    });
    const parsed = JSON.parse(envelope) as { coordination: { mode: string }; v: number };
    expect(parsed.coordination.mode).toBe('reused');
    expect(parsed.v).toBe(1);
  });

  it('omits the coordination block when none is passed', () => {
    const parsed = JSON.parse(formatEnvelope(baselinedResult(), {})) as Record<string, unknown>;
    expect('coordination' in parsed).toBe(false);
  });
});

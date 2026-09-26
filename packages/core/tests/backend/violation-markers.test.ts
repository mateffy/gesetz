import { describe, expect, it } from 'vitest';
import type { Violation } from '../../src/engine/rule';
import {
  GESETZ_EXTENSION,
  VIOLATION_MARKER_TYPE,
  VIOLATION_TYPE,
  isViolationMarker,
  markerToViolation,
  violationToMarker,
  type ViolationMarkerData,
} from '../../src/backend/violation-markers';

const RULE = { id: 'no-console-log', description: 'No console.log', category: 'cleanup' };

describe('violationToMarker', () => {
  it('maps a fully populated violation to a marker', () => {
    const violation: Violation = {
      rule: 'no-console-log',
      message: 'Remove console logging',
      path: 'src/app.ts',
      line: 42,
      column: 13,
      severity: 'error',
      context: 'console.log("x")',
      fix: 'Use a logger',
      source: 'core',
    };

    const marker = violationToMarker(violation, RULE);

    expect(marker.type).toBe('violation');
    expect(marker.lines).toEqual([42]);
    expect(marker.data).toEqual({
      rule: 'no-console-log',
      description: 'No console.log',
      category: 'cleanup',
      message: 'Remove console logging',
      severity: 'error',
      source: 'core',
      column: 13,
      context: 'console.log("x")',
      fix: 'Use a logger',
    } satisfies ViolationMarkerData);
  });

  it('omits lines when the violation has no line', () => {
    const violation: Violation = {
      message: 'Project-level issue',
      path: 'src',
      severity: 'warn',
      source: 'custom',
    };
    const marker = violationToMarker(violation, { id: 'r', description: 'd' });
    expect('lines' in marker).toBe(false);
    expect(marker.data.category).toBeNull();
    expect(marker.data.column).toBeUndefined();
  });

  it('falls back to the rule argument when the violation has no rule id', () => {
    const violation: Violation = {
      message: 'm',
      path: 'a.ts',
      severity: 'info',
      source: 'core',
    };
    const marker = violationToMarker(violation, RULE);
    expect(marker.data.rule).toBe('no-console-log');
  });
});

describe('markerToViolation', () => {
  it('round-trips a violation through marker form', () => {
    const violation: Violation = {
      rule: 'r1',
      message: 'msg',
      path: 'src/x.ts',
      line: 7,
      column: 2,
      severity: 'warn',
      context: 'ctx',
      fix: 'fix it',
      source: 'eslint',
    };
    const marker = violationToMarker(violation, {
      id: 'r1',
      description: 'desc',
      category: 'strictness',
    });
    const back = markerToViolation('src/x.ts', {
      type: marker.type,
      data: marker.data,
      ...(marker.lines !== undefined ? { lines: marker.lines } : {}),
    });
    expect(back).toEqual(violation);
  });

  it('reconstructs a violation without optional fields', () => {
    const marker = violationToMarker(
      { message: 'm', path: 'a.ts', severity: 'error', source: 'core' },
      { id: 'r', description: 'd' },
    );
    const back = markerToViolation('a.ts', { type: marker.type, data: marker.data });
    expect(back.line).toBeUndefined();
    expect(back.column).toBeUndefined();
    expect(back.severity).toBe('error');
  });
});

describe('isViolationMarker', () => {
  it('recognizes violation markers by public type', () => {
    expect(isViolationMarker({ type: VIOLATION_MARKER_TYPE, extension: 'gesetz', data: {} })).toBe(
      true,
    );
    expect(
      isViolationMarker({ type: 'gesetz-syntax.call', extension: 'gesetz-syntax', data: {} }),
    ).toBe(false);
  });
});

describe('constants', () => {
  it('composes the public marker type from extension and type', () => {
    expect(VIOLATION_MARKER_TYPE).toBe(`${GESETZ_EXTENSION}.${VIOLATION_TYPE}`);
  });
});

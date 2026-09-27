import { describe, it, expect } from 'vitest';
import {
  describeCoordination,
  requestKeyFor,
  resolveCoordinationKnobs,
} from '../src/check-coordination';

const baseRequest = {
  root: '/proj',
  configPath: undefined,
  rules: [{ id: 'b' }, { id: 'a' }],
  thresholds: [{ category: 'cleanup', minScore: 7 }],
  fileFilter: null,
  changedSince: undefined,
  baselineBytes: null,
  storage: { kind: 'sqlite', path: '/proj/.gesetz/cache.db' } as const,
};

describe('requestKeyFor', () => {
  it('is stable for the same request', () => {
    expect(requestKeyFor(baseRequest)).toBe(requestKeyFor(baseRequest));
  });

  it('does not depend on the order rules were declared in', () => {
    const reordered = { ...baseRequest, rules: [{ id: 'a' }, { id: 'b' }] };
    expect(requestKeyFor(reordered)).toBe(requestKeyFor(baseRequest));
  });

  it('does not depend on the order of the file filter', () => {
    const a = requestKeyFor({ ...baseRequest, fileFilter: ['x/**', 'y/**'] });
    const b = requestKeyFor({ ...baseRequest, fileFilter: ['y/**', 'x/**'] });
    expect(a).toBe(b);
  });

  it('changes when a rule changes, because the answer would differ', () => {
    const other = { ...baseRequest, rules: [{ id: 'a' }] };
    expect(requestKeyFor(other)).not.toBe(requestKeyFor(baseRequest));
  });

  it('changes when a threshold changes', () => {
    const other = { ...baseRequest, thresholds: [{ category: 'cleanup', minScore: 3 }] };
    expect(requestKeyFor(other)).not.toBe(requestKeyFor(baseRequest));
  });

  it('changes when the file filter changes', () => {
    const other = { ...baseRequest, fileFilter: ['src/**'] };
    expect(requestKeyFor(other)).not.toBe(requestKeyFor(baseRequest));
  });

  it('changes when --since changes', () => {
    const other = { ...baseRequest, changedSince: 'main' };
    expect(requestKeyFor(other)).not.toBe(requestKeyFor(baseRequest));
  });

  it('changes when the baseline contents change', () => {
    const other = { ...baseRequest, baselineBytes: '{"version":1}' };
    expect(requestKeyFor(other)).not.toBe(requestKeyFor(baseRequest));
  });

  it('changes when the cache is bypassed, because a full run answers differently', () => {
    const other = { ...baseRequest, storage: { kind: 'memory' } as const };
    expect(requestKeyFor(other)).not.toBe(requestKeyFor(baseRequest));
  });

  it('changes when the project root changes', () => {
    const other = { ...baseRequest, root: '/elsewhere' };
    expect(requestKeyFor(other)).not.toBe(requestKeyFor(baseRequest));
  });

  it('is a short hex id', () => {
    expect(requestKeyFor(baseRequest)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('resolveCoordinationKnobs', () => {
  const flags = (
    overrides: Partial<Parameters<typeof resolveCoordinationKnobs>[0]['flags']> = {},
  ) => ({
    standalone: false,
    full: false,
    jobs: 1,
    waitTimeoutSeconds: undefined,
    ...overrides,
  });

  it('defaults to one job, not standalone, with no explicit wait timeout', () => {
    expect(resolveCoordinationKnobs({ flags: flags(), env: {} })).toEqual({
      jobs: 1,
      standalone: false,
      waitTimeoutMs: undefined,
    });
  });

  it('takes jobs from the flag', () => {
    expect(resolveCoordinationKnobs({ flags: flags({ jobs: 2 }), env: {} }).jobs).toBe(2);
  });

  it('lets GESETZ_JOBS override the flag', () => {
    expect(
      resolveCoordinationKnobs({ flags: flags({ jobs: 2 }), env: { GESETZ_JOBS: '3' } }).jobs,
    ).toBe(3);
  });

  it('ignores a GESETZ_JOBS that is not a positive number', () => {
    for (const value of ['', '0', '-1', 'many']) {
      expect(
        resolveCoordinationKnobs({ flags: flags({ jobs: 2 }), env: { GESETZ_JOBS: value } }).jobs,
        value,
      ).toBe(2);
    }
  });

  it('honours --standalone', () => {
    expect(
      resolveCoordinationKnobs({ flags: flags({ standalone: true }), env: {} }).standalone,
    ).toBe(true);
  });

  it('treats --full as standalone, because it asks for no caching and no sharing', () => {
    expect(resolveCoordinationKnobs({ flags: flags({ full: true }), env: {} }).standalone).toBe(
      true,
    );
  });

  it('treats GESETZ_LOCK=off as standalone', () => {
    expect(
      resolveCoordinationKnobs({ flags: flags(), env: { GESETZ_LOCK: 'off' } }).standalone,
    ).toBe(true);
  });

  it('does not treat any other GESETZ_LOCK value as standalone', () => {
    expect(
      resolveCoordinationKnobs({ flags: flags(), env: { GESETZ_LOCK: 'on' } }).standalone,
    ).toBe(false);
  });

  it('converts the wait timeout from seconds to milliseconds', () => {
    expect(
      resolveCoordinationKnobs({ flags: flags({ waitTimeoutSeconds: 30 }), env: {} }).waitTimeoutMs,
    ).toBe(30_000);
  });
});

describe('describeCoordination', () => {
  const notice = (overrides: Partial<Parameters<typeof describeCoordination>[0]> = {}): string =>
    describeCoordination({
      mode: 'ran',
      waitedMs: 0,
      runAgeMs: 0,
      listeners: 0,
      recheckedFiles: 0,
      ...overrides,
    });

  it('says it ran when nothing else was active', () => {
    expect(notice()).toBe('coord: ran — no other gesetz check active');
  });

  it('reports the listeners a run had', () => {
    expect(notice({ listeners: 2 })).toContain('2 other processes waited on this run');
  });

  it('singularises one listener', () => {
    expect(notice({ listeners: 1 })).toContain('1 other process waited on this run');
  });

  it('says the worktree is shared when the run re-checked files', () => {
    // The important sentence: a result can describe files this process never
    // touched, and an agent reading violations needs to know that.
    const line = notice({ recheckedFiles: 4 });
    expect(line).toContain('re-checked 4 changed files');
    expect(line).toContain('this worktree is shared');
    expect(line).toContain('some results may not be yours');
  });

  it('singularises one re-checked file', () => {
    expect(notice({ recheckedFiles: 1 })).toContain('re-checked 1 changed file;');
  });

  it('does not claim shared state when nothing was re-checked', () => {
    expect(notice({ recheckedFiles: 0 })).not.toContain('shared');
  });

  it('reports how old the run it reused was', () => {
    const line = notice({ mode: 'reused', runAgeMs: 2_100 });
    expect(line).toContain('reused a run from 2.1s ago');
    expect(line).toContain('already checked');
  });

  it('reports how long it waited before running', () => {
    const line = notice({ mode: 'ran-after-wait', waitedMs: 8_400, runningPid: 1234 });
    expect(line).toContain('waited 8.4s for pid 1234');
    expect(line).toContain('then ran');
  });

  it('omits the pid when there is none to name', () => {
    expect(notice({ mode: 'ran-after-wait', waitedMs: 1_000 })).toContain(
      'coord: waited 1.0s, then ran',
    );
  });

  it('says standalone when standalone was asked for', () => {
    expect(notice({ mode: 'standalone' })).toBe('coord: standalone — not waiting, not reusing');
  });

  it('keeps every notice on one line', () => {
    for (const mode of ['ran', 'reused', 'ran-after-wait', 'standalone'] as const) {
      expect(notice({ mode, recheckedFiles: 3, listeners: 2 })).not.toContain(
        String.fromCharCode(10),
      );
    }
  });
});

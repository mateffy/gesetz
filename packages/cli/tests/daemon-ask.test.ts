import { describe, expect, it } from 'vitest';
import { describeDaemonAnswer } from '../src/daemon-ask';
import type { CheckSpec, DaemonResponse, RunResult } from '@gesetz/core';

const spec: CheckSpec = {
  instanceKey: 'i',
  scope: { files: null, since: null },
  rules: null,
  categories: null,
  baseline: 'apply',
};

const answer = (over: Partial<Extract<DaemonResponse<RunResult>, { ok: true; kind: 'check' }>> = {}) =>
  ({
    v: 1,
    id: 'a',
    ok: true,
    kind: 'check',
    envelope: {} as RunResult,
    servedFrom: 'recomputed',
    checksNotRun: [],
    computedAt: 1_000,
    ...over,
  }) as DaemonResponse<RunResult>;

describe('describeDaemonAnswer', () => {
  it('says it fell back when there was no answer at all', () => {
    expect(describeDaemonAnswer(null, 1_000)).toBe('daemon: no answer — running the check here instead');
  });

  it('repeats the daemon’s own error when it refused', () => {
    expect(describeDaemonAnswer({ v: 1, id: 'a', ok: false, error: 'engine exploded' }, 0)).toContain(
      'engine exploded — running the check here instead',
    );
  });

  it('reports the age of the state it answered from', () => {
    expect(describeDaemonAnswer(answer({ computedAt: 1_000 }), 3_500)).toContain(
      'answered from a state computed 2.5s ago',
    );
  });

  it('names every rule the request decided nothing about', () => {
    // Without this, a `--rule tsc` answer looks like a clean project rather than a
    // statement about one rule.
    const notice = describeDaemonAnswer(answer({ checksNotRun: ['no-god-files', 'vitest'] }), 1_000);
    expect(notice).toContain('decided nothing about: no-god-files, vitest');
  });

  it('says nothing about undecided rules when the request asked for everything', () => {
    expect(describeDaemonAnswer(answer(), 1_000)).not.toContain('decided nothing');
  });

  it('treats a control answer as a fallback, since it is not a check result', () => {
    const control = {
      v: 1,
      id: 'a',
      ok: true,
      kind: 'control',
      envelope: { pid: 1 },
      checksNotRun: [],
      computedAt: 0,
    } as unknown as DaemonResponse<RunResult>;
    expect(describeDaemonAnswer(control, 0)).toContain('running the check here instead');
  });

  it('never reports a negative age, whatever the clocks say', () => {
    expect(describeDaemonAnswer(answer({ computedAt: 9_999 }), 1_000)).toContain('0.0s ago');
  });
});

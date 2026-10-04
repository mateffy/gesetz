import { describe, expect, it } from 'vitest';
import { createLimiter, orderBatches, planBatches } from '../../../src/engine/daemon/queue';
import type { Schedulable } from '../../../src/engine/daemon/queue';

let clock = 0;
const request = (
  id: string,
  files: readonly string[] | null,
  options: { instanceKey?: string; since?: string | null; arrivedAt?: number } = {},
): Schedulable & { id: string } => ({
  id,
  instanceKey: options.instanceKey ?? 'instance',
  scope: { files, since: options.since ?? null },
  arrivedAt: options.arrivedAt ?? (clock += 1),
});

const byId = (item: Schedulable & { id: string }) => item.id;

describe('planBatches', () => {
  it('answers two different scopes of one instance with one run', () => {
    // The point of the whole thing: agents whose scopes differ still share the work.
    const batches = planBatches(
      [request('a', ['src/a.ts']), request('b', ['src/b.ts'])],
      (item) => item.instanceKey,
    );
    expect(batches).toHaveLength(1);
    expect(batches[0]?.files).toEqual(['src/a.ts', 'src/b.ts']);
    expect(batches[0]?.members.map(byId)).toEqual(['a', 'b']);
  });

  it('dedupes identical scopes into one run with both waiters', () => {
    const batches = planBatches(
      [request('a', ['src/**']), request('b', ['src/**'])],
      (item) => item.instanceKey,
    );
    expect(batches).toHaveLength(1);
    expect(batches[0]?.files).toEqual(['src/**']);
    expect(batches[0]?.members).toHaveLength(2);
  });

  it('makes the union the whole project when any member asked for it', () => {
    const batches = planBatches(
      [request('a', ['src/a.ts']), request('b', null)],
      (item) => item.instanceKey,
    );
    expect(batches[0]?.files).toBeNull();
  });

  it('keeps different instances apart, because they are different questions', () => {
    const batches = planBatches(
      [request('a', ['src/**'], { instanceKey: 'one' }), request('b', ['src/**'], { instanceKey: 'two' })],
      (item) => item.instanceKey,
    );
    expect(batches).toHaveLength(2);
  });

  it('keeps different --since cuts apart, because they examine different files', () => {
    const batches = planBatches(
      [request('a', ['src/**'], { since: 'main' }), request('b', ['src/**'], { since: 'HEAD~5' })],
      (item) => `${item.instanceKey}:${item.scope.since ?? ''}`,
    );
    expect(batches).toHaveLength(2);
  });

  it('sorts the union, so one set of paths is one key', () => {
    const batches = planBatches(
      [request('a', ['z.ts', 'a.ts']), request('b', ['m.ts'])],
      (item) => item.instanceKey,
    );
    expect(batches[0]?.files).toEqual(['a.ts', 'm.ts', 'z.ts']);
  });

  it('returns nothing for nothing', () => {
    expect(planBatches<Schedulable & { id: string }>([], (item) => item.instanceKey)).toEqual([]);
  });
});

describe('orderBatches', () => {
  it('does not depend on the order the caller happened to queue them in', () => {
    const first = request('a', ['src/a.ts'], { arrivedAt: 100 });
    const second = request('b', ['src/b.ts'], { arrivedAt: 200 });
    const forwards = planBatches([first, second], (item) => item.instanceKey);
    const backwards = planBatches([second, first], (item) => item.instanceKey);
    expect(forwards[0]?.members.map(byId)).toEqual(['a', 'b']);
    expect(backwards[0]?.members.map(byId)).toEqual(['a', 'b']);
  });

  it('puts a batch holding the oldest member first', () => {
    const old = request('old', ['src/**'], { instanceKey: 'one', arrivedAt: 1 });
    const recent = request('recent', ['src/**'], { instanceKey: 'two', arrivedAt: 2 });
    const batches = planBatches([recent, old], (item) => item.instanceKey);
    expect(orderBatches(batches)[0]?.members.map(byId)).toEqual(['old']);
  });
});

describe('createLimiter', () => {
  it('allows up to the limit and then refuses', () => {
    const limiter = createLimiter(2);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);
    expect(limiter.running).toBe(2);
  });

  it('allows another after a release', () => {
    const limiter = createLimiter(1);
    expect(limiter.tryAcquire()).toBe(true);
    limiter.release();
    expect(limiter.tryAcquire()).toBe(true);
  });

  it('is at least one, and never goes negative', () => {
    const limiter = createLimiter(0);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);
    limiter.release();
    limiter.release();
    expect(limiter.running).toBe(0);
  });
});

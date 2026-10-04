/**
 * Turning a queue of requests into runs.
 *
 * Pure: it decides *what* to run and *for whom*, and never runs anything. The server
 * owns the I/O, which is what lets the scheduling rules be tested as arithmetic
 * rather than with sockets and timers.
 *
 * Two requests can share one run when they agree on everything that changes the
 * answer except the files:
 *
 * - the same **instance** (rules, thresholds, baseline, storage), and
 * - the same **`--since` cut**, because a `--since` run examines only the files that
 *   changed since it, and two different cuts are two different examined sets.
 *
 * Within such a group the run covers the **union** of the requested paths, which
 * covers every member's own request, so each member is answered by narrowing the
 * result to its scope. A member that asked for the whole project (`files: null`)
 * makes the union the whole project, which is sound for every member and is exactly
 * the steady state worth aiming for: one whole-tree run, then free filters.
 */

import type { Scope } from './protocol';

/** The part of a request the queue reasons about. */
export interface Schedulable {
  /** What makes two requests the same question. */
  readonly instanceKey: string;
  readonly scope: Scope;
  /**
   * When the request was queued, in ms epoch. On the request rather than passed
   * alongside it, so the plan does not depend on the order a caller happened to
   * build its array in — two callers with the same queue get the same plan.
   */
  readonly arrivedAt: number;
}

/** A run to perform, and the requests it will answer. */
export interface Batch<T extends Schedulable> {
  /** Stable identity: same key, same run. */
  readonly key: string;
  /**
   * What to run. Null means the whole project — the union of a group one of whose
   * members asked for everything.
   */
  readonly files: readonly string[] | null;
  readonly since: string | null;
  /** By arrival, oldest first, so the longest wait is answered by this run. */
  readonly members: readonly T[];
}

/** Groups requests that can share a run, oldest group first. */
export function planBatches<T extends Schedulable>(
  queued: readonly T[],
  keyOf: (item: T) => string,
): Batch<T>[] {
  const groups = new Map<string, { since: string | null; files: Set<string>; whole: boolean; members: T[] }>();

  for (const item of queued) {
    const key = keyOf(item);
    const existing = groups.get(key);
    const group =
      existing ??
      { since: item.scope.since, files: new Set<string>(), whole: false, members: [] as T[] };
    if (item.scope.files === null) group.whole = true;
    else for (const file of item.scope.files) group.files.add(file);
    group.members.push(item);
    if (existing === undefined) groups.set(key, group);
  }

  return [...groups.entries()].map(([key, group]) => ({
    key,
    files: group.whole ? null : [...group.files].sort(),
    since: group.since,
    members: [...group.members].sort((a, b) => a.arrivedAt - b.arrivedAt),
  }));
}

/**
 * The order to work through batches: the oldest request first, so the client that has
 * been waiting longest is never overtaken by one that arrived later.
 */
export function orderBatches<T extends Schedulable>(batches: readonly Batch<T>[]): Batch<T>[] {
  const oldest = (batch: Batch<T>): number =>
    Math.min(...batch.members.map((member) => member.arrivedAt));
  return [...batches].sort((a, b) => oldest(a) - oldest(b));
}

/**
 * A plain concurrency limit, and nothing more.
 *
 * `jobs` is the number of runs allowed at once. Deliberately not a scheduler: every
 * decision about *what* to run lives in `planBatches`, and this only answers whether
 * another run may start.
 */
export function createLimiter(limit: number): {
  readonly running: number;
  tryAcquire(): boolean;
  release(): void;
} {
  const max = Math.max(1, Math.floor(limit));
  let running = 0;
  return {
    get running(): number {
      return running;
    },
    tryAcquire(): boolean {
      if (running >= max) return false;
      running += 1;
      return true;
    },
    release(): void {
      running = Math.max(0, running - 1);
    },
  };
}

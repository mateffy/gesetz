/**
 * Coordination for several `gesetz check` processes in one working tree.
 *
 * Ten agents editing one worktree and each running the full check is ten scans
 * and ten runs of every external tool for the same tree. `coordinateRun` lets a
 * caller wait for the run in flight and then reuse its result when that result
 * describes the same tree state — keyed on observed state, never on recency,
 * because a result computed before a caller's edit is a wrong answer for that
 * caller.
 *
 * The files this reads and writes are described in `run-lock-files.ts`.
 */
import {
  DEFAULT_STALE_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
  POLL_MS,
  acquireSlot,
  countWaiters,
  findReusableRecord,
  isAlivePid,
  readSlot,
  registerWaiter,
  slotPathFor,
  takeOverSlot,
  writeRecord,
  type RunRecord,
  type Slot,
  type Waiter,
} from './run-lock-files';
import { treeStatesMatch, treeStateFor } from './file-set';

export {
  acquireSlot,
  coordDirFor,
  countWaiters,
  findReusableRecord,
  readRecords,
  readSlot,
  registerWaiter,
  releaseSlot,
  takeOverSlot,
  writeRecord,
} from './run-lock-files';
export type { RunRecord, Slot, SlotFile, Waiter } from './run-lock-files';

export type CoordinationMode = 'ran' | 'reused' | 'ran-after-wait' | 'standalone';

export type CoordinationEvent =
  | { readonly type: 'ran' }
  | { readonly type: 'waited'; readonly waitedMs: number; readonly runningPid: number }
  | {
      readonly type: 'reused';
      readonly waitedMs: number;
      readonly runAgeMs: number;
      readonly listeners: number;
    }
  | { readonly type: 'took-over'; readonly staleMs: number; readonly deadPid: number };

export interface CoordinateOptions<R> {
  readonly root: string;
  /** Identity of the question, excluding the scope. */
  readonly requestKey: string;
  /** The requested paths and `--since` cut. */
  readonly scopeKey: string;
  /** The scope key a whole-tree run of this instance would have. */
  readonly fullScopeKey: string;
  /** How many runs may proceed at once. Default 1. */
  readonly jobs?: number | undefined;
  /** Run now, with no lock, no waiting and no reuse. `--standalone`. */
  readonly standalone?: boolean | undefined;
  readonly staleMs?: number | undefined;
  readonly pollMs?: number | undefined;
  readonly waitTimeoutMs?: number | undefined;
  /**
   * How many files this scan reprocessed, for the notices. A getter, because the
   * number is only known after the work has run.
   */
  readonly recheckedFiles?: (() => number) | undefined;
  readonly onEvent?: ((event: CoordinationEvent) => void) | undefined;
  readonly run: () => Promise<R>;
}

export interface CoordinationOutcome<R> {
  readonly result: R;
  readonly mode: CoordinationMode;
  /**
   * Time spent in the wait loop before this outcome. Zero for a run that started
   * immediately, and for a result that came from a record.
   */
  readonly waitedMs: number;
  /**
   * Time the work itself took. Separate from `waitedMs` because they answer
   * different questions: one says whether the fleet is queueing, the other says
   * whether the check is slow.
   */
  readonly runMs: number;
  readonly runAgeMs: number;
  readonly listeners: number;
  /** How many files the run that produced this result re-checked. */
  readonly recheckedFiles: number;
  /** Which process produced a reused result. */
  readonly reusedFromPid?: number | undefined;
  /**
   * For a reused result: whether it came from a run at this exact scope, or from a
   * whole-tree run that has to be narrowed to this caller's scope before it is
   * reported. Absent for a run this caller performed.
   */
  readonly reusedScope?: 'same' | 'full' | undefined;
  readonly events: readonly CoordinationEvent[];
}

interface StaleTakeover {
  readonly staleMs: number;
  readonly deadPid: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Takes over the first slot whose holder is gone, and says what it displaced.
 *
 * Every slot is examined, not just the first: with `jobs` above 1 a fleet holds
 * slots 0..N, and a dead holder of slot 3 strands its waiters exactly as long as a
 * dead holder of slot 0 does. Examining only slot 0 was correct while `jobs` could
 * not exceed 1, which is no longer true.
 */
function takeOverIfStale(root: string, staleMs: number, jobs: number): StaleTakeover | null {
  for (let index = 0; index < jobs; index += 1) {
    const stale = readSlot(slotPathFor(root, index));
    if (stale === null) continue;
    const now = Date.now();
    const age = now - stale.heartbeatAt;
    if (age <= staleMs) continue;
    if (isAlivePid(stale.pid)) continue;
    if (!takeOverSlot(root, index, now)) continue;
    return { staleMs: age, deadPid: stale.pid };
  }
  return null;
}

/**
 * Claims any free slot, up to `jobs`. Kept apart from the main loop so the loop
 * reads as one decision per branch rather than four levels of nesting.
 */
function acquireAnySlot(
  root: string,
  jobs: number,
  staleMs: number,
): { slot: Slot | null; tookOver: StaleTakeover | null } {
  for (let index = 0; index < jobs; index += 1) {
    const slot = acquireSlot(root, index);
    if (slot !== null) return { slot, tookOver: null };
  }
  // Every slot is held. One of them may be a dead holder, and clearing it lets the
  // caller retry immediately instead of sleeping out the wait timeout.
  return { slot: null, tookOver: takeOverIfStale(root, staleMs, jobs) };
}

/**
 * Run, reuse, or wait — whichever lets the answer be produced once for a tree.
 *
 * Order is deliberate: reuse first (no work at all), then run (we hold a slot),
 * then wait (someone else is working), then reuse again (their answer may
 * already cover us). A caller only ever waits *without* running: while another
 * process works, this one sleeps and does nothing else.
 */
export async function coordinateRun<R>(
  options: CoordinateOptions<R>,
): Promise<CoordinationOutcome<R>> {
  const jobs = Math.max(1, options.jobs ?? 1);
  const pollMs = options.pollMs ?? POLL_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const startedAt = Date.now();
  const events: CoordinationEvent[] = [];
  const emit = (event: CoordinationEvent): void => {
    events.push(event);
    options.onEvent?.(event);
  };

  if (options.standalone === true) {
    const runStartedAt = Date.now();
    const result = await options.run();
    const runMs = Date.now() - runStartedAt;
    emit({ type: 'ran' });
    return {
      result,
      mode: 'standalone',
      waitedMs: 0,
      runMs,
      runAgeMs: 0,
      listeners: 0,
      recheckedFiles: options.recheckedFiles?.() ?? 0,
      events,
    };
  }

  const reuseNow = (): { record: RunRecord<R>; reusedScope: 'same' | 'full' } | null =>
    findReusableRecord<R>(
      options.root,
      options.requestKey,
      options.scopeKey,
      options.fullScopeKey,
      treeStateFor(options.root),
    );

  const reused = (
    hit: { record: RunRecord<R>; reusedScope: 'same' | 'full' },
    waitedMs: number,
  ): CoordinationOutcome<R> => {
    const { record, reusedScope } = hit;
    const runAgeMs = Date.now() - record.finishedAt;
    emit({ type: 'reused', waitedMs, runAgeMs, listeners: record.listeners });
    return {
      result: record.result,
      mode: 'reused',
      waitedMs,
      runMs: 0,
      runAgeMs,
      listeners: record.listeners,
      recheckedFiles: record.recheckedFiles,
      reusedFromPid: record.pid,
      reusedScope,
      events,
    };
  };

  /** The work, with a slot held. Publishes the record before releasing it. */
  const runHolding = async (slot: Slot, waitedMs: number): Promise<CoordinationOutcome<R>> => {
    const before = treeStateFor(options.root);
    // The caller's wait, not the caller's clock: `waitedMs` used to be measured from
    // when the caller entered, so on the `ran` path it reported the *duration of the
    // run* under a name that says "how long this waited". They are different numbers.
    const runStartedAt = Date.now();
    try {
      const result = await options.run();
      const after = treeStateFor(options.root);
      // Counted now, not when the run started: the waiters worth reporting are the
      // ones that arrived while this run was working.
      const listeners = countWaiters(options.root);
      // Publishing before releasing is what makes a waiter find an answer instead
      // of repeating the work.
      if (slot.beat()) {
        writeRecord(options.root, {
          version: 2,
          requestKey: options.requestKey,
          scopeKey: options.scopeKey,
          fullScopeKey: options.fullScopeKey,
          treeState: after,
          startedAt,
          finishedAt: Date.now(),
          pid: process.pid,
          // A tree that changed mid-run is a mixture of two states, so nobody else
          // may reuse this result. Our own caller still gets it: it is what a solo
          // run would have produced.
          dirty: !treeStatesMatch(before, after),
          listeners,
          recheckedFiles: options.recheckedFiles?.() ?? 0,
          result,
        });
      }
      const runMs = Date.now() - runStartedAt;
      emit({ type: 'ran' });
      return {
        result,
        mode: waitedMs > 0 ? 'ran-after-wait' : 'ran',
        waitedMs,
        runMs,
        runAgeMs: 0,
        listeners,
        recheckedFiles: options.recheckedFiles?.() ?? 0,
        events,
      };
    } finally {
      slot.release();
    }
  };

  const initial = reuseNow();
  if (initial !== null) return reused(initial, 0);

  let waiter: Waiter | null = null;
  let didWait = false;
  const stopWaiting = (): void => {
    waiter?.unregister();
    waiter = null;
  };

  /**
   * Uses a held slot: reuses a record that appeared while waiting, else runs.
   * Extracted so the loop below stays one decision per line.
   */
  const useSlot = async (slot: Slot): Promise<CoordinationOutcome<R>> => {
    if (didWait) {
      const late = reuseNow();
      if (late !== null) {
        stopWaiting();
        slot.release();
        return reused(late, Date.now() - startedAt);
      }
    }
    stopWaiting();
    return await runHolding(slot, didWait ? Date.now() - startedAt : 0);
  };

  try {
    for (;;) {
      const { slot, tookOver } = acquireAnySlot(options.root, jobs, staleMs);
      if (slot !== null) return await useSlot(slot);

      // A takeover freed a slot: retry immediately rather than sleeping.
      if (tookOver !== null) {
        emit({ type: 'took-over', staleMs: tookOver.staleMs, deadPid: tookOver.deadPid });
        continue;
      }

      // Every slot is held: someone else is working. Wait without working.
      if (waiter === null) {
        waiter = registerWaiter(options.root);
        didWait = true;
      }
      const waitedMs = Date.now() - startedAt;
      if (waitedMs >= waitTimeoutMs) {
        // A gate that waits forever is not a gate. Run anyway, and report it.
        stopWaiting();
        const holder = readSlot(slotPathFor(options.root, 0));
        emit({ type: 'waited', waitedMs, runningPid: holder?.pid ?? 0 });
        const runStartedAt = Date.now();
        const result = await options.run();
        const runMs = Date.now() - runStartedAt;
        emit({ type: 'ran' });
        return {
          result,
          mode: 'ran-after-wait',
          waitedMs,
          runMs,
          runAgeMs: 0,
          listeners: 0,
          recheckedFiles: options.recheckedFiles?.() ?? 0,
          events,
        };
      }
      await sleep(pollMs);
      const late = reuseNow();
      if (late !== null) {
        stopWaiting();
        return reused(late, Date.now() - startedAt);
      }
    }
  } finally {
    stopWaiting();
  }
}

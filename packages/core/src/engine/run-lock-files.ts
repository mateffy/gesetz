/**
 * The filesystem half of run coordination: slots, run records, waiters.
 *
 * Every piece of shared state is a small JSON file under
 * `<root>/.gesetz/coord/`. There is no server and no socket, so a crashed
 * participant leaves at most a stale file that the next one ignores or takes
 * over. The policy that uses these files lives in `run-lock.ts`.
 */
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { createHash } from 'node:crypto';
import { treeStatesMatch, type TreeState } from './file-set';

const COORD_DIR = 'coord';
const SLOT_PREFIX = 'lock';
const WAITER_PREFIX = 'wait';
const RECORD_PREFIX = 'run';
const SEP = '.';
const JSON_SUFFIX = '.json';
/** Chars of the random suffix that keeps two records for one request apart. */
const RECORD_ID_LENGTH = 8;

/** How often a holder rewrites its heartbeat. */
export const HEARTBEAT_MS = 2_000;
/** How long a waiter sleeps between checks. */
export const POLL_MS = 150;
/** A slot with no heartbeat for this long, held by a dead pid, is stale. */
export const DEFAULT_STALE_MS = 15_000;
/** How long a caller waits for a run before giving up and running itself. */
export const DEFAULT_WAIT_TIMEOUT_MS = 600_000;
/** Records younger than this are kept even when pruning. */
export const RECORD_TTL_MS = 60_000;
/** How many records pruning keeps regardless of age. */
const RECORDS_KEPT = 8;

export interface SlotFile {
  readonly pid: number;
  readonly startedAt: number;
  readonly heartbeatAt: number;
}

export interface RunRecord<R = unknown> {
  readonly version: 1;
  readonly requestKey: string;
  readonly treeState: TreeState;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly pid: number;
  /** True when the tree changed while the run was in progress. */
  readonly dirty: boolean;
  readonly listeners: number;
  readonly recheckedFiles: number;
  readonly result: R;
}

export function coordDirFor(root: string): string {
  return nodePath.join(root, '.gesetz', COORD_DIR);
}

function ensureCoordDir(root: string): string {
  const dir = coordDirFor(root);
  nodeFs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function slotPathFor(root: string, slot: number): string {
  return nodePath.join(coordDirFor(root), slot === 0 ? SLOT_PREFIX : `${SLOT_PREFIX}.${slot}`);
}

/** Reads a JSON file, or null when it is missing, unreadable or not JSON. */
function readJsonFile<T>(path: string): T | null {
  try {
    return JSON.parse(nodeFs.readFileSync(path, 'utf8')) as T;
  } catch {
    // A half-written or corrupt file is not evidence of anything. Callers treat
    // null as "no such record", which is the safe reading.
    return null;
  }
}

export function readSlot(path: string): SlotFile | null {
  return readJsonFile<SlotFile>(path);
}

function writeJsonAtomic(path: string, value: unknown): void {
  const temporary = `${path}.tmp.${process.pid}`;
  nodeFs.writeFileSync(temporary, JSON.stringify(value));
  nodeFs.renameSync(temporary, path);
}

/** Deletes a file if it is there. `force` absorbs the race with another remover. */
function removeQuietly(path: string): void {
  nodeFs.rmSync(path, { force: true });
}

/** `EPERM` means the process exists but belongs to another user: alive. */
export function isAlivePid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface Slot {
  readonly index: number;
  readonly path: string;
  readonly startedAt: number;
  /** Re-write the heartbeat; false once the slot has been taken over. */
  beat(): boolean;
  /** True when the holder looks dead: an old heartbeat and a pid that is gone. */
  isStale(now: number, staleMs?: number): boolean;
  release(): void;
}

/**
 * Claims slot `index`, or returns null when another live process holds it.
 *
 * `wx` is `O_CREAT|O_EXCL`, so exactly one process wins.
 */
export function acquireSlot(root: string, index: number): Slot | null {
  ensureCoordDir(root);
  const path = slotPathFor(root, index);
  const startedAt = Date.now();
  try {
    nodeFs.writeFileSync(
      path,
      JSON.stringify({ pid: process.pid, startedAt, heartbeatAt: startedAt } satisfies SlotFile),
      { flag: 'wx' },
    );
  } catch {
    return null;
  }

  let stolen = false;
  let timer: NodeJS.Timeout | undefined;
  const beat = (): boolean => {
    if (stolen) return false;
    const current = readSlot(path);
    if (current === null || current.pid !== process.pid || current.startedAt !== startedAt) {
      // Someone renamed us aside and took over. Stop claiming the slot, so our
      // heartbeat cannot overwrite theirs.
      stolen = true;
      if (timer !== undefined) clearInterval(timer);
      return false;
    }
    try {
      writeJsonAtomic(path, { ...current, heartbeatAt: Date.now() });
    } catch {
      // A heartbeat that cannot be written is a slot we no longer hold. This runs
      // from a timer, where a throw would be an unhandled exception and would take
      // the whole process down.
      return false;
    }
    return true;
  };
  timer = setInterval(beat, HEARTBEAT_MS);
  timer.unref();

  return {
    index,
    path,
    startedAt,
    beat,
    isStale: (now: number, staleMs: number = DEFAULT_STALE_MS): boolean => {
      if (stolen) return false;
      const current = readSlot(path);
      if (current === null) return false;
      if (now - current.heartbeatAt <= staleMs) return false;
      return !isAlivePid(current.pid);
    },
    release: (): void => {
      if (timer !== undefined) clearInterval(timer);
      const current = readSlot(path);
      if (current !== null && current.pid === process.pid && current.startedAt === startedAt) {
        removeQuietly(path);
      }
    },
  };
}

export function releaseSlot(slot: Slot): void {
  slot.release();
}

/**
 * Moves a stale slot aside so a fresh one can be created.
 *
 * The rename is the race breaker: only one process can rename a given path, so
 * two waiters that both decide a slot is stale cannot both take it over.
 */
export function takeOverSlot(root: string, index: number, now: number): boolean {
  const path = slotPathFor(root, index);
  const stalePath = `${path}.stale.${process.pid}.${now}`;
  try {
    nodeFs.renameSync(path, stalePath);
  } catch {
    return false; // another waiter got there first
  }
  removeQuietly(stalePath);
  return true;
}

function recordPathFor(root: string, requestKey: string): string {
  const unique = createHash('sha256')
    .update(`${process.pid}:${process.hrtime.bigint()}`)
    .digest('hex')
    .slice(0, RECORD_ID_LENGTH);
  return nodePath.join(
    coordDirFor(root),
    `${RECORD_PREFIX}${SEP}${requestKey}${SEP}${unique}${JSON_SUFFIX}`,
  );
}

export function writeRecord<R>(root: string, record: RunRecord<R>): void {
  ensureCoordDir(root);
  writeJsonAtomic(recordPathFor(root, record.requestKey), record);
  pruneRecords(root);
}

function recordNames(root: string): string[] {
  try {
    return nodeFs
      .readdirSync(coordDirFor(root))
      .filter((name) => name.startsWith(`${RECORD_PREFIX}${SEP}`) && name.endsWith(JSON_SUFFIX));
  } catch {
    return []; // no coordination directory: no records
  }
}

export function readRecords(root: string): RunRecord[] {
  const dir = coordDirFor(root);
  const records: RunRecord[] = [];
  for (const name of recordNames(root)) {
    const record = readJsonFile<RunRecord>(nodePath.join(dir, name));
    if (record !== null) records.push(record);
  }
  return records;
}

/** Keeps the newest few records plus anything young enough that a waiter may still want it. */
function pruneRecords(root: string): void {
  const dir = coordDirFor(root);
  const now = Date.now();
  const records = readRecords(root).sort((a, b) => b.finishedAt - a.finishedAt);
  const keep = new Set(records.slice(0, RECORDS_KEPT).map((record) => record.finishedAt));
  for (const record of records) {
    if (now - record.finishedAt < RECORD_TTL_MS) keep.add(record.finishedAt);
  }
  for (const name of recordNames(root)) {
    const path = nodePath.join(dir, name);
    const record = readJsonFile<RunRecord>(path);
    if (record !== null && !keep.has(record.finishedAt)) removeQuietly(path);
  }
  pruneDeadWaiters(root);
}

/** Waiter files from dead processes are garbage that would be counted forever. */
function pruneDeadWaiters(root: string): void {
  const dir = coordDirFor(root);
  let names: string[];
  try {
    names = nodeFs.readdirSync(dir);
  } catch {
    return; // no coordination directory: nothing to prune
  }
  for (const name of names) {
    if (!name.startsWith(`${WAITER_PREFIX}${SEP}`)) continue;
    if (!name.endsWith(JSON_SUFFIX)) continue;
    const path = nodePath.join(dir, name);
    const waiter = readJsonFile<{ pid: number }>(path);
    if (waiter !== null && !isAlivePid(waiter.pid)) removeQuietly(path);
  }
}

/**
 * The newest completed record that answers this request for this exact tree
 * state. A dirty record is never reusable: the tree changed while it ran, so it
 * describes a mixture of two states.
 */
export function findReusableRecord<R>(
  root: string,
  requestKey: string,
  treeState: TreeState,
): RunRecord<R> | null {
  const candidates = readRecords(root)
    .filter(
      (record) =>
        record.requestKey === requestKey &&
        record.dirty === false &&
        treeStatesMatch(record.treeState, treeState),
    )
    .sort((a, b) => b.finishedAt - a.finishedAt);
  return (candidates[0] as RunRecord<R> | undefined) ?? null;
}

export interface Waiter {
  unregister(): void;
}

/**
 * Announces that this process is waiting, so the holder can report how many
 * listeners a run had. The heartbeat is what stops a crashed waiter from
 * counting forever; `countWaiters` also checks that the pid is alive.
 */
export function registerWaiter(
  root: string,
  overrides: { pid?: number; heartbeatAt?: number } = {},
): Waiter {
  const path = nodePath.join(
    ensureCoordDir(root),
    `${WAITER_PREFIX}${SEP}${process.pid}${JSON_SUFFIX}`,
  );
  const write = (): void => {
    try {
      writeJsonAtomic(path, {
        pid: overrides.pid ?? process.pid,
        heartbeatAt: overrides.heartbeatAt ?? Date.now(),
      });
    } catch {
      // Also timer-driven: a waiter that cannot announce itself is still a waiter,
      // and this must not throw where nothing can catch it.
      return;
    }
  };
  write();
  const timer = setInterval(write, HEARTBEAT_MS);
  timer.unref();
  return {
    unregister: (): void => {
      clearInterval(timer);
      removeQuietly(path);
    },
  };
}

/** Distinct live processes currently waiting. */
export function countWaiters(root: string): number {
  const dir = coordDirFor(root);
  let names: string[];
  try {
    names = nodeFs.readdirSync(dir);
  } catch {
    return 0; // no coordination directory: nobody is waiting
  }
  const pids = new Set<number>();
  for (const name of names) {
    if (!name.startsWith(`${WAITER_PREFIX}${SEP}`)) continue;
    if (!name.endsWith(JSON_SUFFIX)) continue;
    const waiter = readJsonFile<{ pid: number }>(nodePath.join(dir, name));
    if (waiter !== null && isAlivePid(waiter.pid)) pids.add(waiter.pid);
  }
  return pids.size;
}

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import {
  acquireSlot,
  coordDirFor,
  countWaiters,
  findReusableRecord,
  readSlot,
  registerWaiter,
  releaseSlot,
  writeRecord,
  type RunRecord,
} from '../../src/engine/run-lock-files';
import { treeStateFor } from '../../src/engine/file-set';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-coord-files-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const FULL = 'scope-full';

const record = (overrides: Partial<RunRecord> = {}): RunRecord => ({
  version: 2,
  requestKey: 'k1',
  scopeKey: FULL,
  fullScopeKey: FULL,
  treeState: treeStateFor(root),
  startedAt: Date.now() - 100,
  finishedAt: Date.now(),
  pid: 999_999,
  dirty: false,
  listeners: 0,
  recheckedFiles: 0,
  result: { hello: 'world' },
  ...overrides,
});

describe('slots', () => {
  it('creates the coordination directory on first acquire', () => {
    const slot = acquireSlot(root, 0);
    expect(slot).not.toBeNull();
    expect(readSlot(slot!.path)?.pid).toBe(process.pid);
  });

  it('refuses a second acquire of the same slot', () => {
    expect(acquireSlot(root, 0)).not.toBeNull();
    expect(acquireSlot(root, 0)).toBeNull();
  });

  it('gives each slot its own file, so two can be held at once', () => {
    // How many may be held is coordinateRun's job (the `jobs` option); this
    // primitive only has to keep them apart.
    const first = acquireSlot(root, 0)!;
    const second = acquireSlot(root, 1)!;
    expect(first.path).not.toBe(second.path);
    expect(readSlot(first.path)?.pid).toBe(process.pid);
    expect(readSlot(second.path)?.pid).toBe(process.pid);
  });

  it('frees the slot on release', () => {
    const slot = acquireSlot(root, 0)!;
    releaseSlot(slot);
    expect(acquireSlot(root, 0)).not.toBeNull();
  });

  it('reports a slot whose heartbeat is old and whose pid is dead as stale', () => {
    const slot = acquireSlot(root, 0)!;
    nodeFs.writeFileSync(slot.path, JSON.stringify({ pid: 999_999, startedAt: 0, heartbeatAt: 0 }));
    expect(slot.isStale(Date.now(), 100)).toBe(true);
  });

  it('does not report a live holder as stale, however old its heartbeat looks', () => {
    const slot = acquireSlot(root, 0)!;
    nodeFs.writeFileSync(
      slot.path,
      JSON.stringify({ pid: process.pid, startedAt: slot.startedAt, heartbeatAt: 0 }),
    );
    expect(slot.isStale(Date.now(), 100)).toBe(false);
  });
});

describe('records', () => {
  it('round-trips a record', () => {
    writeRecord(root, record());
    const found = findReusableRecord(root, 'k1', FULL, FULL, treeStateFor(root));
    expect(found?.record.result).toEqual({ hello: 'world' });
    expect(found?.reusedScope).toBe('full');
  });

  it('does not return a record for a different request key', () => {
    writeRecord(root, record());
    expect(findReusableRecord(root, 'k2', FULL, FULL, treeStateFor(root))).toBeNull();
  });

  it('does not return a dirty record', () => {
    writeRecord(root, record({ dirty: true }));
    expect(findReusableRecord(root, 'k1', FULL, FULL, treeStateFor(root))).toBeNull();
  });

  it('does not return a record for a different tree state', async () => {
    writeRecord(root, record());
    await writeFile(nodePath.join(root, 'new-file.ts'), 'x');
    expect(findReusableRecord(root, 'k1', FULL, FULL, treeStateFor(root))).toBeNull();
  });

  it('prefers the newest matching record', () => {
    writeRecord(root, record({ finishedAt: 1, result: { which: 'old' } }));
    writeRecord(root, record({ finishedAt: 2, result: { which: 'new' } }));
    expect(findReusableRecord(root, 'k1', FULL, FULL, treeStateFor(root))?.record.result).toEqual({ which: 'new' });
  });

  it('ignores a corrupt record rather than throwing', async () => {
    await mkdir(coordDirFor(root), { recursive: true });
    await writeFile(nodePath.join(coordDirFor(root), 'run.k1.deadbeef.json'), '{ not json');
    expect(findReusableRecord(root, 'k1', FULL, FULL, treeStateFor(root))).toBeNull();
  });

  it('ignores a non-record file in the coordination directory', async () => {
    await mkdir(coordDirFor(root), { recursive: true });
    await writeFile(nodePath.join(coordDirFor(root), 'notes.txt'), 'hello');
    expect(findReusableRecord(root, 'k1', FULL, FULL, treeStateFor(root))).toBeNull();
  });
});

describe('waiters', () => {
  it('counts a registered waiter', () => {
    const waiter = registerWaiter(root);
    expect(countWaiters(root)).toBe(1);
    waiter.unregister();
    expect(countWaiters(root)).toBe(0);
  });

  it('does not count a waiter whose pid is dead', () => {
    registerWaiter(root, { pid: 999_999, heartbeatAt: 1 });
    expect(countWaiters(root)).toBe(0);
  });

  it('does not count a waiter with a corrupt file', async () => {
    await mkdir(coordDirFor(root), { recursive: true });
    await writeFile(nodePath.join(coordDirFor(root), 'wait.12345.json'), 'nope');
    expect(countWaiters(root)).toBe(0);
  });
});

describe('scope coverage: who may answer for whom', () => {
  it('lets a whole-tree record answer a narrow scope', () => {
    // The fleet's whole point: one agent pays for the full run and every scoped
    // request afterwards is answered from it, narrowed to its own paths.
    writeRecord(root, record({ scopeKey: FULL, result: { which: 'full' } }));
    const found = findReusableRecord(root, 'k1', 'scope-mine', FULL, treeStateFor(root));
    expect(found?.reusedScope).toBe('full');
    expect(found?.record.result).toEqual({ which: 'full' });
  });

  it('never lets one narrow scope answer another', () => {
    // A scoped run examined its own paths and nothing else. Reusing it here would
    // report this caller's files as clean without having looked at them.
    writeRecord(root, record({ scopeKey: 'scope-other', result: { which: 'other' } }));
    expect(findReusableRecord(root, 'k1', 'scope-mine', FULL, treeStateFor(root))).toBeNull();
  });

  it('answers an identical narrow scope, and says it is the same scope', () => {
    writeRecord(root, record({ scopeKey: 'scope-mine', result: { which: 'mine' } }));
    const found = findReusableRecord(root, 'k1', 'scope-mine', FULL, treeStateFor(root));
    expect(found?.reusedScope).toBe('same');
  });

  it('prefers the record at this exact scope over a newer whole-tree one', () => {
    // An exact-scope record needs no narrowing, and it was produced for precisely
    // this question, so it wins even when the whole-tree run is more recent.
    writeRecord(root, record({ scopeKey: FULL, finishedAt: 9, result: { which: 'full' } }));
    writeRecord(root, record({ scopeKey: 'scope-mine', finishedAt: 8, result: { which: 'mine' } }));
    const found = findReusableRecord(root, 'k1', 'scope-mine', FULL, treeStateFor(root));
    expect(found?.record.result).toEqual({ which: 'mine' });
    expect(found?.reusedScope).toBe('same');
  });

  it('ignores a version 1 record, which cannot say what it examined', () => {
    writeRecord(root, record({ version: 1 as unknown as 2 }));
    expect(findReusableRecord(root, 'k1', FULL, FULL, treeStateFor(root))).toBeNull();
  });
});
